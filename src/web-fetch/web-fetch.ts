/**
 * Read a public page through Google's Antigravity fetch service.
 *
 * This integration uses the Google-only retrieval path observed in the official `agy`
 * CLI. The crawl runs on Google's side using the account's OAuth token:
 *
 *   1. `v1internal:rewriteUri` resolves a redirect chain and reports the final URI.
 *   2. `v1internal:fetchFromTrawlerCache` answers from Google's crawl cache, and a
 *      404 there means "not cached" rather than "no such page".
 *   3. The same RPC with `liveFetch: true` retries missing or inadequate copies.
 *
 * The response is crawled source, usually HTML. Inspection preserves metadata and
 * recovery links before Markdown cleanup; output is capped before reaching a model.
 * No local HTTP client or JavaScript renderer contacts the target site. The official
 * CLI's direct-download fallback is not implemented here.
 */
import {
  antigravityHeaders,
  endpointCandidates,
  jsonOrTextError,
  parseApiKey,
} from "../client/client.js";
import { checkPublicUrl } from "../utils/address.js";
import { antigravityFetch } from "../utils/http.js";
import { boundaryForward, capText, cleanText, elideMiddle, repairText } from "../utils/text.js";
import { redactSecrets, safeError } from "../utils/security.js";
import { antigravityEnv, isRecord } from "../utils/util.js";
import { DocumentLimitError } from "./document.js";
import { looksLikeHtml } from "./markdown.js";

import { inspectPage, inspectUnconverted, type PageInspection } from "./inspect.js";
import { mediaKind } from "./media.js";
import { representationFor } from "./representation.js";
import { siteRepresentation } from "./sites.js";
import { DEFAULT_WEB_FETCH_MAX_CHARS, WEB_FETCH_TIMEOUT_MS, MAX_RESPONSE_BYTES } from "./limits.js";
import { formatWebFetchHeader } from "./header.js";
import { FENCE_LINE, unclosedFence } from "./fences.js";
import {
  runWithDiagnostics,
  setLastEndpoint,
  setLastStatus,
  setLastError,
  setLastLatencyMs,
  setLastFetchTrace,
} from "../diagnostics/index.js";

export const REWRITE_URI_PATH = "/v1internal:rewriteUri";
export const TRAWLER_FETCH_PATH = "/v1internal:fetchFromTrawlerCache";

export { DEFAULT_WEB_FETCH_MAX_CHARS, WEB_FETCH_TIMEOUT_MS } from "./limits.js";
export { formatWebFetchHeader } from "./header.js";

export type WebFetchSource = "cache" | "live";

export type WebFetchOptions = {
  apiKey?: string;
  /** Page to read. */
  url: string;
  /** Return the crawled source instead of Markdown. */
  raw?: boolean;
  /** Character budget for the returned content. */
  maxChars?: number;
  /** Testable network deadline; defaults to ten seconds. */
  timeoutMs?: number;
  signal?: AbortSignal;
};

export type WebFetchResult = {
  /** URL as requested. */
  requestedUrl: string;
  /** Whether the raw requested and resolved URLs differed before display redaction. */
  redirected?: boolean;
  /** URL the fetch service finally read, after any redirect. */
  resolvedUrl: string;
  /** Converted page content; each consumer owns its complete output budget. */
  content: string;
  title?: string;
  description?: string;
  /** Date the page states it was last modified, when it states one. */
  updated?: string;
  /** Whether the crawl cache answered, or the page was fetched live. */
  source: WebFetchSource;
  /** Size of the crawler response before conversion and truncation. */
  bytes: number;
  /** Whether the returned content was capped at the character budget. */
  truncated: boolean;
  /** True if incomplete, false if complete, or null when the source is ambiguous. */
  partial: boolean | null;
  /** Assessment of the extracted content, independent of source completeness. */
  assessment?: PageInspection["assessment"];
  author?: string;
  notes?: string[];
  published?: string;
  language?: string;
  /** Actual fetched representation, when different from the article URL. */
  representationUrl?: string;
  attempts?: Array<{
    url: string;
    source: WebFetchSource;
    outcome: string;
    endpoint?: string;
    stage?: string;
  }>;
  /** Character budget used for this result, including header and footer space. */
  maxChars?: number;
};

/**
 * Validate a target URL, returning its normalized form.
 *
 * The fetch runs on Google's machines, so a private address is not a request-forgery
 * risk here, but it can never be reached from there: rejecting it locally turns a
 * confusing remote failure into a clear message. URLs with embedded credentials are
 * refused because they would be sent to a third party. Sensitive query values are still
 * sent with the request, but are redacted from displayed output and errors.
 */
export function validateFetchTarget(raw: string): string {
  const checked = checkPublicUrl(raw);
  if (checked.ok) return checked.url;
  const messages = {
    missing: "A URL is required.",
    invalid: "Not a valid public HTTP(S) URL.",
    scheme: "Only http and https URLs can be read.",
    credentials: "URLs with embedded credentials are not supported.",
    local: "That URL is a private or local address, which the fetch service cannot reach.",
    "too-long": "The URL exceeds the 2,048-character limit.",
  };
  throw Object.assign(new Error(messages[checked.reason]), {
    unsafeTarget: checked.reason !== "invalid",
  });
}

const PDF_GUIDANCE =
  "This tool does not support PDF content. Do not retry this URL with read_url_content. " +
  "If permitted, use an available download tool or terminal to download it directly, then read the local file with a PDF reader. " +
  "Downloading alone does not extract its text.";

function pdfError(url?: string): Error {
  return Object.assign(
    new Error(`${url ? `Unsupported representation ${redactSecrets(url)}: ` : ""}${PDF_GUIDANCE}`),
    { fatal: true, status: 415 },
  );
}

/** A small leading text window for signature detection, not PDF parsing. */
const PDF_HEADER_WINDOW = 1_024;

function isPdfContentType(contentType?: string): boolean {
  return mediaKind(contentType) === "pdf";
}

/** PDF detection is not limited to a URL suffix; inspect the returned representation too. */
function isPdfContent(content: string, contentType?: string): boolean {
  if (isPdfContentType(contentType)) return true;
  // A PDF signature must begin a line, followed by a version. Prose mentioning
  // "%PDF-1.7" is not a binary document.
  return /(?:^|[\r\n])%PDF-\d\.\d(?:[\r\n]|$)/.test(content.slice(0, PDF_HEADER_WINDOW));
}

/** Reject known PDF URLs with guidance for the calling agent. */
function rejectPdfUrl(url: string): void {
  if (/\.pdf$/i.test(new URL(url).pathname)) throw pdfError(url);
}

/** Request body for the redirect resolver. */
export function buildRewriteUriRequest(originalUri: string): Record<string, unknown> {
  return { originalUri };
}

/** Request body for the crawl cache, and for the live fetch when the cache misses. */
export function buildTrawlerFetchRequest(url: string, live = false): Record<string, unknown> {
  return live ? { url, liveFetch: true } : { url };
}

/** Some Cloud Code Assist methods answer with a `response` wrapper; accept both shapes. */
function unwrapResponse(data: unknown): unknown {
  if (isRecord(data) && isRecord(data.response)) return data.response;
  return data;
}

function firstNonEmptyText(...values: unknown[]): string | undefined {
  for (const value of values) if (typeof value === "string" && value.trim()) return value;
  return undefined;
}

/** Final URI from a rewrite response, when the request was redirected. */
export function parseRedirectUri(data: unknown): string | undefined {
  const body = unwrapResponse(data);
  if (!isRecord(body)) return undefined;
  const value = firstNonEmptyText(body.redirectUri, body.redirect_uri, body.rewrittenUri);
  return value?.trim();
}

/** Page content from a trawler response. */
export function parseTrawlerContent(data: unknown): string | undefined {
  const body = unwrapResponse(data);
  if (!isRecord(body)) return undefined;
  const content = firstNonEmptyText(body.content, body.markdownContent);
  return content === undefined ? undefined : repairText(content);
}

/** Explicit media type from a trawler response, when the service reports one. */
export function parseTrawlerContentType(data: unknown): string | undefined {
  const body = unwrapResponse(data);
  if (!isRecord(body)) return undefined;
  return firstNonEmptyText(body.contentType, body.content_type, body.mimeType, body.mime_type)
    ?.split(";")[0]
    .trim()
    .toLowerCase();
}

/** Character budget, from the caller or `ANTIGRAVITY_WEB_FETCH_MAX_CHARS`. */
export function resolveMaxChars(explicit?: number): number {
  if (typeof explicit === "number" && Number.isSafeInteger(Math.floor(explicit)) && explicit >= 1) {
    return Math.floor(explicit);
  }
  const configured = Number(antigravityEnv("WEB_FETCH_MAX_CHARS"));
  return Number.isSafeInteger(Math.floor(configured)) && configured >= 1
    ? Math.floor(configured)
    : DEFAULT_WEB_FETCH_MAX_CHARS;
}

type JsonPost = {
  status: number;
  data: unknown;
  text: string;
};

/** Error for a response the tool refuses to read; retrying cannot make it smaller. */
function tooLargeError(): Error {
  return Object.assign(new Error("The fetch response was too large to read safely."), {
    fatal: true,
    status: 413,
  });
}

/** Read a response without allowing an unbounded body into the parser. */
async function readResponseText(response: Response): Promise<string> {
  const declared = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    throw tooLargeError();
  }
  const body = response.body;
  const reader = body && typeof body.getReader === "function" ? body.getReader() : undefined;
  if (!reader) {
    // A response without a readable stream has to be buffered; keep one copy of it.
    if (typeof response.arrayBuffer === "function") {
      const buffer = await response.arrayBuffer();
      if (buffer.byteLength > MAX_RESPONSE_BYTES) throw tooLargeError();
      return new TextDecoder().decode(buffer);
    }
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > MAX_RESPONSE_BYTES) throw tooLargeError();
    return text;
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw tooLargeError();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

async function postJson(
  endpoint: string,
  path: string,
  headers: Record<string, string>,
  body: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<JsonPost> {
  setLastEndpoint(endpoint);
  const response = await antigravityFetch(`${endpoint}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal,
  });
  setLastStatus(response.status);
  const text = await readResponseText(response);
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : undefined;
  } catch {
    data = undefined;
  }
  return { status: response.status, data, text };
}

type RetrievalStage = "cache" | "live" | "representation";
/** A cache miss is not a page failure; all other stages share the same status policy. */
export function statusAction(
  stage: RetrievalStage,
  status: number,
): "content" | "missing" | "recover" | "stop" {
  if (status === 200) return "content";
  if (status === 401 || status === 403) return "stop";
  if (stage === "cache" && (status < 400 || status === 404 || status === 410)) return "missing";
  return status === 429 || status >= 500 ? "recover" : "stop";
}

/** Error carrying a stage-independent retry/refusal decision. */
function fetchError(text: string, status: number, stage: RetrievalStage): Error {
  const detail = capText(repairText(redactSecrets(jsonOrTextError(text))), 400) || `HTTP ${status}`;
  const message =
    stage === "cache"
      ? `The crawl cache could not answer (HTTP ${status}: ${detail}).`
      : `The live fetch failed (HTTP ${status}: ${detail}). Try again later, or open the page in a browser.`;
  return Object.assign(new Error(message), {
    fatal: statusAction(stage, status) === "stop",
    status,
  });
}

/** Whether a validation failure names a private or local destination. */
function isUnsafeTarget(error: unknown): boolean {
  return error instanceof Error && (error as { unsafeTarget?: boolean }).unsafeTarget === true;
}

/** Resolve best-effort, but reject any unsafe destination the service reports. */
async function resolveRedirect(
  endpoint: string,
  url: string,
  headers: Record<string, string>,
  signal?: AbortSignal,
  strict = false,
  request = postJson,
): Promise<string | undefined> {
  let redirect: string | undefined;
  try {
    const response = await request(
      endpoint,
      REWRITE_URI_PATH,
      headers,
      buildRewriteUriRequest(url),
      signal,
    );
    if (response.status !== 200) {
      if (strict) throw new Error(`Alternate redirect resolver failed (HTTP ${response.status}).`);
      return undefined;
    }
    redirect = parseRedirectUri(response.data);
  } catch (error) {
    // Original-page resolution is best-effort. Alternate recovery must fail closed.
    if (strict) throw error;
  }
  if (!redirect || redirect === url) return undefined;
  let absolute: string;
  try {
    absolute = new URL(redirect, url).toString();
  } catch (error) {
    // A malformed destination says nothing about the requested page; keep reading it.
    if (strict) throw error;
    return undefined;
  }
  if (absolute === url) return undefined;
  try {
    return validateFetchTarget(absolute);
  } catch (error) {
    // An unsafe destination the service reports fails closed. A malformed or
    // unsupported target only costs the redirect, so the read continues.
    if (strict || isUnsafeTarget(error))
      throw new Error(`The service reported an unsafe redirect: ${safeError(error)}`, {
        cause: error,
      });
    return undefined;
  }
}

/** Close a code fence the character cap cut through, so the note is not read as code. */
function keepFencesClosed(markdown: string): string {
  const fence = unclosedFence(markdown);
  return fence ? `${markdown}\n${fence.prefix}${fence.marker.repeat(fence.length)}` : markdown;
}

function splitsSurrogate(text: string, index: number): boolean {
  return (
    index > 0 &&
    index < text.length &&
    /[\uD800-\uDBFF]/.test(text[index - 1]) &&
    /[\uDC00-\uDFFF]/.test(text[index])
  );
}

/** Move a character boundary off a surrogate pair and outside a fence delimiter line. */
function safeTruncate(text: string, end: number, start = 0): number {
  let next = Math.min(text.length, Math.max(start, end));
  next = boundaryForward(text, next);
  if (next <= start || next >= text.length) return next;
  const lineStart = text.lastIndexOf("\n", next - 1) + 1;
  const lineEndRaw = text.indexOf("\n", next);
  const lineEnd = lineEndRaw < 0 ? text.length : lineEndRaw;
  if (next > lineStart && next < lineEnd && FENCE_LINE.test(text.slice(lineStart, lineEnd))) {
    if (lineStart > start) return lineStart;
    // A delimiter line longer than the whole range cannot be skipped without
    // losing the range, so the budget bound wins and the fence is closed later.
    return Math.min(lineEnd < text.length ? lineEnd + 1 : text.length, next);
  }
  return next;
}

/** Format the rendered page, extract metadata, and apply the character budget. */
function toResult(params: {
  requestedUrl: string;
  resolvedUrl: string;
  content: string;
  rendered: string;
  source: WebFetchSource;
  maxChars: number;
  inspection: PageInspection;
  representationUrl?: string;
  attempts: NonNullable<WebFetchResult["attempts"]>;
}): WebFetchResult {
  const { requestedUrl, resolvedUrl, content, source, maxChars, inspection } = params;
  // Redact caller/service URLs wherever the page echoes them, before the page is shown or saved.
  let rendered = repairText(params.rendered);
  for (const url of [requestedUrl, resolvedUrl, params.representationUrl]) {
    if (url) rendered = rendered.replaceAll(url, redactSecrets(url));
  }
  const metadata = inspection.metadata;
  const completeness = inspection.completeness;
  const partial = completeness === "complete" ? false : completeness === "incomplete" ? true : null;
  const provisional: WebFetchResult = {
    requestedUrl: redactSecrets(requestedUrl),
    resolvedUrl: redactSecrets(resolvedUrl),
    redirected: requestedUrl !== resolvedUrl,
    content: rendered,
    title: metadata.title,
    description: metadata.description,
    updated: metadata.updated,
    source,
    bytes: 0,
    truncated: false,
    partial,
    assessment: inspection.assessment,
    notes: inspection.notes,
    author: metadata.author,
    published: metadata.published,
    language: metadata.language,
    representationUrl: params.representationUrl
      ? redactSecrets(params.representationUrl)
      : undefined,
    attempts: params.attempts,
    maxChars,
  };
  return {
    ...provisional,
    bytes: new TextEncoder().encode(content).byteLength,
    truncated: rendered.length + formatWebFetchHeader(provisional).length > maxChars,
  };
}

/** Inspect a page; raw mode keeps a source beyond the conversion limits as it is. */
function inspectSource(
  content: string,
  url: string,
  contentType: string | undefined,
  raw: boolean | undefined,
): PageInspection {
  try {
    return inspectPage(content, url, contentType);
  } catch (error) {
    if (raw && error instanceof DocumentLimitError)
      return inspectUnconverted(content, error.message);
    throw error;
  }
}

function recordFailure(
  attempt: NonNullable<WebFetchResult["attempts"]>[number],
  error: unknown,
  retained: boolean,
  timedOut: boolean,
): void {
  const status = error instanceof Error ? (error as { status?: number }).status : undefined;
  if (timedOut) attempt.outcome = "overall deadline exceeded";
  else if (status === 415) attempt.outcome = "unsupported PDF content";
  else if (status === 413) attempt.outcome = "response too large to read safely";
  else if (status !== undefined) attempt.outcome = `HTTP ${status}`;
  else if (attempt.outcome === "HTTP 200")
    attempt.outcome = `content inspection failed: ${cleanText(safeError(error), 120) ?? "unknown error"}`;
  if (retained) attempt.outcome += "; retained usable copy";
}

type Candidate = {
  content: string;
  inspection: PageInspection;
  resolvedUrl: string;
  representationUrl?: string;
  source: WebFetchSource;
};

/** Prefer readable article evidence, then a closed source, then additional content. */
function candidateRank(candidate: Candidate): number {
  const page = candidate.inspection;
  return (
    (page.assessment === "readable"
      ? 4_000_000
      : page.assessment === "suspected-shell"
        ? 1_000_000
        : 0) +
    (page.completeness === "complete"
      ? 2_000_000
      : page.completeness === "unknown"
        ? 1_000_000
        : 0) +
    Math.min(page.rendered.length, 999_999)
  );
}

/** A readable fragment is usable; only positive signs of a problem trigger recovery. */
function needsRecovery(candidate: Candidate): boolean {
  return (
    candidate.inspection.assessment !== "readable" ||
    candidate.inspection.completeness === "incomplete" ||
    // Google cuts these sites' ordinary pages; only a verified copy is complete.
    (candidate.inspection.completeness !== "complete" &&
      !candidate.representationUrl &&
      siteRepresentation(candidate.resolvedUrl) !== undefined)
  );
}

/**
 * Read through Google only: inspect cache, recover live when inadequate, and try
 * one advertised same-origin article representation. Keep the best usable copy
 * if recovery fails; never splice different versions of an article together.
 */
export class WebFetchError extends Error {
  readonly attempts: NonNullable<WebFetchResult["attempts"]>;
  constructor(url: string, detail: string, attempts: WebFetchResult["attempts"] = []) {
    const trail = formatAttemptTrail(attempts);
    super(
      repairText(
        redactSecrets(`Could not read ${url}: ${detail}${trail ? ` (Attempts: ${trail})` : ""}`),
      ),
    );
    this.name = "WebFetchError";
    this.attempts = attempts;
  }
}

function formatAttemptTrail(attempts: WebFetchResult["attempts"]): string {
  return (attempts ?? [])
    .map(
      (attempt) =>
        `${attempt.stage ?? attempt.source}@${attempt.endpoint ?? "Google"} ${elideMiddle(attempt.url, 256)}: ${attempt.outcome}`,
    )
    .join(" → ");
}

export async function executeAntigravityWebFetch(
  options: WebFetchOptions,
): Promise<WebFetchResult> {
  return runWithDiagnostics(async () => {
    const started = performance.now();
    try {
      const result = await fetchPage(options);
      setLastFetchTrace(formatAttemptTrail(result.attempts));
      if (result.assessment !== "readable" || result.partial !== false)
        setLastError(
          `Degraded fetch: assessment=${result.assessment ?? "unknown"}; partial=${result.partial}; ${result.attempts?.map((attempt) => `${attempt.stage ?? attempt.source}: ${attempt.outcome}`).join(" → ") ?? ""}`,
        );
      return result;
    } catch (error) {
      const checked = checkPublicUrl(options.url);
      const safe =
        error instanceof WebFetchError
          ? error
          : new WebFetchError(
              checked.ok ? redactSecrets(checked.url) : "the supplied URL",
              safeError(error),
            );
      setLastError(safe.message);
      setLastFetchTrace(formatAttemptTrail(safe.attempts));

      throw safe;
    } finally {
      setLastLatencyMs(Math.round(performance.now() - started));
    }
  });
}

async function fetchPage(options: WebFetchOptions): Promise<WebFetchResult> {
  const requestedUrl = validateFetchTarget(options.url);
  rejectPdfUrl(requestedUrl);
  const deadline = AbortSignal.timeout(options.timeoutMs ?? WEB_FETCH_TIMEOUT_MS);
  const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
  const creds = parseApiKey(options.apiKey);
  const headers = antigravityHeaders(creds.token);
  const maxChars = resolveMaxChars(options.maxChars);
  const attempts: NonNullable<WebFetchResult["attempts"]> = [];
  let best: Candidate | undefined;
  let lastError = "no endpoint available";
  // Google's copy, kept when it is beyond the conversion limits so the caller can save it.
  let unconvertedCopy: string | undefined;
  let lastContent: string | undefined;
  let requests = 0;
  let endpointAnswered: boolean;
  let alternateTried = false;
  const endpoints = endpointCandidates();
  const unavailable = new Set<string>();
  const requested = new Set<string>();
  const request: typeof postJson = async (_endpoint, path, requestHeaders, body, requestSignal) => {
    let attempt = attempts.at(-1);
    if (path === REWRITE_URI_PATH) {
      attempt = {
        url: cleanText(redactSecrets(String(body.originalUri ?? "")), 2_048)!,
        source: "cache",
        stage: "redirect",
        outcome: "transport failed",
      };
      attempts.push(attempt);
    }
    for (const endpoint of endpoints) {
      if (unavailable.has(endpoint)) continue;
      const key = JSON.stringify([endpoint, path, body]);
      if (requested.has(key)) continue;
      if (requests >= 10)
        throw Object.assign(
          new Error("The bounded fetch request budget was exhausted. Open the page in a browser."),
          { fatal: true },
        );
      requested.add(key);
      requests += 1;
      if (attempt) attempt.endpoint = endpoint;
      try {
        const response = await postJson(endpoint, path, requestHeaders, body, requestSignal);
        if (attempt) attempt.outcome = `HTTP ${response.status}`;
        if (path === TRAWLER_FETCH_PATH) endpointAnswered = true;
        return response;
      } catch (error) {
        if (
          requestSignal?.aborted ||
          (error instanceof Error && (error as { fatal?: boolean }).fatal)
        )
          throw error;
        unavailable.add(endpoint);
        if (attempt) {
          // Preserve this failed endpoint, then keep the caller's live record at the
          // end so later inspection updates the endpoint that actually answered.
          const failed = { ...attempt, outcome: "transport failed" };
          attempts.splice(attempts.length - 1, 0, failed);
        }
        lastError = capText(repairText(safeError(error)), 400);
      }
    }
    if (attempt) attempts.pop(); // No physical request corresponds to the pending record.
    throw Object.assign(new Error(`No Google endpoint could complete this request: ${lastError}`), {
      fatal: true,
    });
  };
  const aborted = () => {
    if (options.signal?.aborted) throw new Error("Web fetch aborted");
  };
  const usable = (candidate: Candidate | undefined): boolean =>
    Boolean(
      candidate &&
      (candidate.inspection.rendered.trim() || (options.raw && candidate.content.trim())),
    );
  const retain = (candidate: Candidate) => {
    if (!best || candidateRank(candidate) > candidateRank(best)) best = candidate;
  };
  const result = (candidate: Candidate) =>
    toResult({
      requestedUrl,
      resolvedUrl: candidate.resolvedUrl,
      content: candidate.content,
      rendered: options.raw ? candidate.content : candidate.inspection.rendered,
      source: candidate.source,
      maxChars,
      inspection: candidate.inspection,
      representationUrl: candidate.representationUrl,
      attempts,
    });

  // Per-request dispatch owns endpoint failover; never repeat the whole retrieval flow.
  for (const endpoint of endpoints.slice(0, 1)) {
    endpointAnswered = false;
    aborted();
    if (deadline.aborted) break;
    const resolvedUrl =
      (await resolveRedirect(endpoint, requestedUrl, headers, signal, false, request)) ??
      requestedUrl;
    aborted();
    rejectPdfUrl(resolvedUrl);
    let page: Candidate | undefined;
    let alternatePage: Candidate | undefined;
    for (const source of ["cache", "live"] as const) {
      aborted();
      if (deadline.aborted) break;
      const attempt = {
        url: cleanText(redactSecrets(resolvedUrl), 2_048)!,
        endpoint,
        stage: source,
        source,
        outcome: "transport failed",
      };
      attempts.push(attempt);
      try {
        const response = await request(
          endpoint,
          TRAWLER_FETCH_PATH,
          headers,
          buildTrawlerFetchRequest(resolvedUrl, source === "live"),
          signal,
        );
        aborted();
        attempt.outcome = `HTTP ${response.status}`;
        if (response.status !== 200) {
          // The cache saying "not here" leaves the live fetch to try.
          if (statusAction(source, response.status) === "missing") continue;
          throw fetchError(response.text, response.status, source);
        }
        const contentType = parseTrawlerContentType(response.data);
        if (isPdfContentType(contentType)) throw pdfError();
        const content = parseTrawlerContent(response.data);
        lastContent = content;
        if (content === undefined) {
          attempt.outcome = "empty response";
          lastError = /error|message/i.test(response.text)
            ? capText(redactSecrets(jsonOrTextError(response.text)), 400)
            : "Google returned no readable article content.";
          continue;
        }
        if (isPdfContent(content, contentType)) throw pdfError();
        const candidate: Candidate = {
          content,
          resolvedUrl,
          source,
          inspection: inspectSource(content, resolvedUrl, contentType, options.raw),
        };
        attempt.outcome = `${candidate.inspection.assessment}; source ${candidate.inspection.completeness}`;
        retain(candidate);
        if (
          candidate.inspection.alternates.length &&
          (!alternatePage || candidateRank(candidate) > candidateRank(alternatePage))
        )
          alternatePage = candidate;
        if (!page || candidateRank(candidate) > candidateRank(page)) page = candidate;
        if (!needsRecovery(candidate)) return result(candidate);
      } catch (error) {
        aborted();
        recordFailure(attempt, error, source !== "cache" && usable(best), deadline.aborted);
        if (
          error instanceof Error &&
          (error as { fatal?: boolean }).fatal &&
          (source === "cache" || !usable(best))
        )
          throw new WebFetchError(requestedUrl, safeError(error), attempts);
        lastError = capText(repairText(safeError(error)), 400);
        const unconvertible = error instanceof DocumentLimitError;
        if (unconvertible && lastContent) {
          unconvertedCopy = repairText(lastContent);
          for (const url of [requestedUrl, resolvedUrl])
            unconvertedCopy = unconvertedCopy.replaceAll(url, redactSecrets(url));
        }
        if (!endpointAnswered || unconvertible) break;
      }
    }
    // Raw mode means the requested page source, not a substituted representation.
    const discovery = alternatePage ?? page;
    const representation = options.raw
      ? undefined
      : representationFor(resolvedUrl, discovery?.inspection.alternates[0]);
    if (representation && !deadline.aborted && !alternateTried) {
      alternateTried = true;
      aborted();
      let representationAttempt: NonNullable<WebFetchResult["attempts"]>[number] | undefined;
      try {
        const url = validateFetchTarget(representation.url);
        rejectPdfUrl(url);
        const redirected = representation.resolve
          ? await resolveRedirect(endpoint, url, headers, signal, true, request)
          : undefined;
        aborted();
        if (deadline.aborted) break;
        if (redirected && new URL(redirected).origin !== new URL(url).origin) {
          attempts.push({
            url: cleanText(redactSecrets(url), 2_048)!,
            source: "live",
            endpoint,
            stage: "representation",
            outcome: "cross-origin redirect rejected",
          });
        } else {
          const representationUrl = redirected ?? url;
          representationAttempt = {
            url: cleanText(redactSecrets(representationUrl), 2_048)!,
            endpoint,
            stage: "representation",
            source: "live",
            outcome: "transport failed",
          };
          attempts.push(representationAttempt);
          rejectPdfUrl(representationUrl);
          const response = await request(
            endpoint,
            TRAWLER_FETCH_PATH,
            headers,
            buildTrawlerFetchRequest(representationUrl, true),
            signal,
          );
          aborted();
          representationAttempt.outcome = `HTTP ${response.status}`;
          if (response.status === 200) {
            const content = parseTrawlerContent(response.data);
            const reportedType = parseTrawlerContentType(response.data);
            if (content !== undefined && isPdfContent(content, reportedType)) throw pdfError();
            const document =
              content === undefined
                ? undefined
                : representation.read(content, reportedType, resolvedUrl);
            if (document?.body.trim()) {
              const articleUrl = document.articleUrl ?? resolvedUrl;
              const inspection = inspectPage(document.body, articleUrl, document.contentType);
              if (document.completeness) inspection.completeness = document.completeness;
              if (document.notes) inspection.notes = document.notes;
              const defined = (metadata: object | undefined) =>
                Object.fromEntries(
                  Object.entries(metadata ?? {}).filter(([, value]) => value !== undefined),
                );
              inspection.metadata = {
                ...discovery?.inspection.metadata,
                ...defined(document.metadata),
                ...defined(inspection.metadata),
              };
              const alternateLanguage =
                inspection.metadata.language ?? document.language ?? representation.language;
              const pageLanguage = discovery?.inspection.metadata.language;
              if (alternateLanguage) inspection.metadata.language = alternateLanguage;
              // The alternate was chosen by base language, so the note compares the same.
              const sameLanguage =
                alternateLanguage?.split("-")[0].toLowerCase() ===
                pageLanguage?.split("-")[0].toLowerCase();
              representationAttempt.outcome =
                alternateLanguage && pageLanguage && !sameLanguage
                  ? `${inspection.assessment}; alternate language ${alternateLanguage}`
                  : inspection.assessment;
              const candidate: Candidate = {
                content: content!,
                resolvedUrl: articleUrl,
                representationUrl,
                source: "live",
                inspection,
              };
              retain(candidate);
              if (!needsRecovery(candidate)) return result(candidate);
            } else {
              representationAttempt.outcome = "no supported article body";
              if (/error|message/i.test(content ?? ""))
                lastError = capText(redactSecrets(jsonOrTextError(content!)), 400);
            }
          } else {
            lastError = capText(
              safeError(fetchError(response.text, response.status, "representation")),
              400,
            );
            representationAttempt.outcome = `HTTP ${response.status}${usable(best) ? "; retained usable copy" : ""}`;
          }
        }
      } catch (error) {
        aborted();
        if (representationAttempt)
          recordFailure(representationAttempt, error, usable(best), deadline.aborted);
        if (error instanceof Error && (error as { fatal?: boolean }).fatal && !usable(best))
          throw new WebFetchError(requestedUrl, safeError(error), attempts);
        lastError = capText(repairText(safeError(error)), 400);
      }
    }
    // A useful partial result beats an error; recovery is bounded to this endpoint.
    if (best && usable(best)) return result(best);
    if (endpointAnswered) break;
  }
  aborted();
  if (best && usable(best)) return result(best);
  if (best && best.inspection.completeness !== "complete" && looksLikeHtml(best.content))
    return result(best);
  if (best)
    lastError =
      best.inspection.assessment === "suspected-shell"
        ? "This appears to be a JavaScript-rendered page; this tool cannot render it. Open it in a browser."
        : "Google returned no readable article content. The response may be truncated, blocked, or a page shell; try another representation or open it in a browser.";
  if (deadline.aborted)
    lastError =
      "The web fetch exceeded its overall 10-second deadline. Try again later or open the page in a browser.";
  throw Object.assign(new WebFetchError(requestedUrl, lastError, attempts), { unconvertedCopy });
}

/**
 * Render a result as the block a model or the user reads.
 *
 * The requested URL is only printed when it differs from the source, so a redirect is
 * visible without repeating the same URL twice on ordinary pages, and an incomplete
 * crawler copy is called out rather than passed off as the whole page.
 */
export function formatWebFetchResult(result: WebFetchResult, footer = ""): string {
  const prefix = formatWebFetchHeader(result);
  const maxChars = result.maxChars ?? DEFAULT_WEB_FETCH_MAX_CHARS;
  const available = maxChars - prefix.length - footer.length;
  if (available < 1)
    throw new Error(
      "The character budget is too small for page provenance. Open the page in a browser or ask the user to increase ANTIGRAVITY_WEB_FETCH_MAX_CHARS.",
    );
  if (result.content.length <= available) return prefix + result.content + footer;

  // A saved-page footer already says where the rest is.
  const note = footer ? "\n\n…" : `\n\n… [output truncated at ${maxChars} characters]`;
  let end = Math.max(0, available - note.length);
  for (;;) {
    if (splitsSurrogate(result.content, end)) end -= 1;
    const boundary = safeTruncate(result.content, end);
    // A delimiter line larger than the budget cannot be included in this output.
    end = boundary > end ? result.content.lastIndexOf("\n", end - 1) + 1 : boundary;
    const body = keepFencesClosed(result.content.slice(0, end)) + note;
    if (body.length <= available) return prefix + body + footer;
    if (end === 0) return prefix + note.slice(0, available) + footer;
    end = Math.max(0, end - (body.length - available));
  }
}

export type FetchCommandArgs = {
  url: string;
  raw: boolean;
};

/** Parse `/antigravity.fetch [--raw] <url>`. */
export function parseFetchCommandArgs(args: string): FetchCommandArgs {
  const tokens = args.trim().split(/\s+/).filter(Boolean);
  const rest: string[] = [];
  let raw = false;
  for (const token of tokens) {
    if (token === "--raw") {
      raw = true;
      continue;
    }
    rest.push(token);
  }
  return { url: rest.join(" "), raw };
}
