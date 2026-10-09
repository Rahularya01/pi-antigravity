import {
  antigravityHeaders,
  endpointCandidates,
  jsonOrTextError,
  parseApiKey,
} from "../client/client.js";
import { AntigravityRequestType, AntigravityUserAgent, GeminiRole } from "../types/enums.js";
import { antigravityFetch } from "../utils/http.js";
import { safeError } from "../utils/security.js";
import { antigravityEnv, antigravityRequestEnvelope, isRecord } from "../utils/util.js";

/** Default search model: fast grounding model for interactive tool calls. */
export const DEFAULT_SEARCH_MODEL = "gemini-3.5-flash-lite";

/** Fallback runtime candidates if the primary model is missing or out of capacity. */
export const SEARCH_MODEL_FALLBACKS = [
  DEFAULT_SEARCH_MODEL,
  "gemini-3.1-flash-lite",
  "gemini-3-flash",
] as const;

export const SEARCH_SYSTEM_INSTRUCTION = `You are a careful research assistant using Google Search grounding.
Return a compact evidence brief with exactly these sections:
## Findings
## Gaps
## Next checks

Rules:
- Verify each claim inside the specific item, function, or section it refers to. Do not copy an attribute from a neighboring entry on the same page.
- Prefer primary documentation and exact names, versions, and constraints over marketing summaries.
- If a fact is not supported by a retrieved source, put it under Gaps instead of stating it as a finding.
- Keep the brief short enough for an interactive agent tool call.`;

export type SearchSource = {
  /** Original groundingChunks index, including gaps from skipped non-web chunks. */
  index?: number;
  title: string;
  url: string;
  /**
   * Destination recovered by following the grounding redirect. Google wraps every
   * source in an opaque `.../grounding-api-redirect/<token>` URL whose path carries
   * no information, so this is what citations should link to when available.
   */
  resolvedUrl?: string;
  /** The page's `<title>` (or `og:title`), when it could be fetched. */
  pageTitle?: string;
  /** Rendered label: page title, else host plus readable path, else host. */
  label?: string;
};

export type SearchSupport = {
  text: string;
  startIndex?: number;
  endIndex?: number;
  partIndex?: number;
  sourceIndices: number[];
};

export type SearchResult = {
  text: string;
  sources: SearchSource[];
  queries: string[];
  /** Optional so existing callers can still construct results with the original shape. */
  parts?: Array<{ index: number; text: string }>;
  supports?: SearchSupport[];
};

export type ExecuteSearchOptions = {
  apiKey?: string;
  query: string;
  instruction?: string;
  urls?: string[];
  thinking?: boolean;
  signal?: AbortSignal;
};

export type SearchCommandArgs = {
  query: string;
  urls?: string[];
  thinking?: boolean;
};

/**
 * Parse arguments for the interactive `/antigravity.search` command.
 * Supports flags:
 *   --thinking: enable deep reasoning for search planning
 *   --url <url>: pass target URL for context analysis (can be repeated)
 *
 * @param args - Raw string of CLI arguments.
 * @returns Parsed command arguments containing query, optional URLs, and thinking flag.
 */
export function parseSearchCommandArgs(args: string): SearchCommandArgs {
  const tokens = args.trim().split(/\s+/).filter(Boolean);
  const out: SearchCommandArgs = { query: "" };
  const rest: string[] = [];

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === undefined) continue;
    const next = tokens[i + 1];

    if (token === "--thinking") {
      out.thinking = true;
      continue;
    }
    if (token === "--url" && next) {
      out.urls = out.urls ?? [];
      out.urls.push(next);
      i += 1;
      continue;
    }
    rest.push(token);
  }

  out.query = rest.join(" ");
  return out;
}

/**
 * Builds the Antigravity wire request payload for Gemini Google Search Grounding.
 * Includes the required `requestType` and `requestId` envelope fields.
 *
 * @param options - Options including search query, lead agent directives, target URLs, and thinking preference.
 * @param model - Target model identifier (e.g., `gemini-3-flash`).
 * @param projectId - Google Cloud Project ID.
 * @returns Serialized request object matching the Antigravity wire contract.
 */
export function buildSearchRequest(
  options: {
    query: string;
    instruction?: string;
    urls?: string[];
    thinking?: boolean;
  },
  model: string,
  projectId: string,
): Record<string, unknown> {
  let systemInstructionText = SEARCH_SYSTEM_INSTRUCTION;
  if (options.instruction?.trim()) {
    systemInstructionText += `\n\n[SPECIFIC DIRECTIVE FROM LEAD AGENT]:\n${options.instruction.trim()}\nYou MUST strictly follow this directive during search query formulation and synthesis.`;
  }

  let prompt = options.query.trim();
  if (options.instruction?.trim()) {
    prompt = `[Lead Agent Directive]: ${options.instruction.trim()}\n\nSearch Query: ${prompt}`;
  }
  if (options.urls && options.urls.length > 0) {
    prompt += `\n\nURLs to analyze in detail:\n${options.urls.join("\n")}`;
  }

  const tools: Array<Record<string, unknown>> = [{ googleSearch: {} }];
  if (options.urls && options.urls.length > 0) {
    tools.push({ urlContext: {} });
  }

  // Default budget stays at 0 so interactive lookups stay fast. --thinking opts into planning.
  const thinkingBudget = options.thinking ? 4096 : 0;
  const envelope = antigravityRequestEnvelope(model, false);

  return {
    project: projectId,
    model,
    request: {
      systemInstruction: {
        role: GeminiRole.User,
        parts: [{ text: systemInstructionText }],
      },
      contents: [
        {
          role: GeminiRole.User,
          parts: [{ text: prompt }],
        },
      ],
      tools,
      generationConfig: {
        thinkingConfig: {
          thinkingBudget,
          includeThoughts: false,
        },
      },
    },
    requestType: AntigravityRequestType.Agent,
    userAgent: AntigravityUserAgent.Antigravity,
    requestId: envelope.requestId,
  };
}

/** Read candidates from either the wrapped Antigravity or direct Gemini response. */
function candidateList(data: unknown): unknown {
  if (!isRecord(data)) return undefined;
  if (isRecord(data.response)) return data.response.candidates;
  return data.candidates;
}

/** Return the first array entry without assuming its response shape. */
function firstUnknownItem(value: unknown): unknown {
  if (!Array.isArray(value)) return undefined;
  return (value as unknown[])[0];
}

/**
 * Parse visible candidate text and grounding metadata from an Antigravity response.
 * Preserve original part and source indices so UTF-8 citation offsets remain usable.
 *
 * @param data - Raw JSON response from Antigravity generateContent API.
 * @returns Synthesized text, web queries, sources, and grounding supports.
 */
export function parseSearchResponse(data: unknown): SearchResult {
  const result: SearchResult = { text: "", sources: [], queries: [], parts: [], supports: [] };
  if (!isRecord(data)) return result;

  const responseObj = isRecord(data.response) ? data.response : data;
  const candidates = Array.isArray(responseObj.candidates)
    ? (responseObj.candidates as unknown[])
    : [];
  const candidate = candidates[0];

  if (!isRecord(candidate)) {
    const errorObj = isRecord(data.error)
      ? data.error
      : isRecord(responseObj.error)
        ? responseObj.error
        : undefined;
    const msg =
      typeof errorObj?.message === "string"
        ? errorObj.message
        : "No candidate returned from Antigravity Search";
    result.text = `Error: ${msg}`;
    return result;
  }

  // Extract synthesized text (ignoring thinking parts)
  const content = isRecord(candidate.content) ? candidate.content : undefined;
  if (Array.isArray(content?.parts)) {
    result.parts = content.parts.flatMap((part, index) =>
      isRecord(part) && !part.thought && typeof part.text === "string" && part.text
        ? [{ index, text: part.text }]
        : [],
    );
    result.text = result.parts.map((part) => part.text).join("\n\n");
  }

  // Extract grounding citations & executed queries
  const grounding = isRecord(candidate.groundingMetadata) ? candidate.groundingMetadata : undefined;
  if (grounding) {
    if (Array.isArray(grounding.webSearchQueries)) {
      result.queries = grounding.webSearchQueries.filter((q): q is string => typeof q === "string");
    }
    if (Array.isArray(grounding.groundingChunks)) {
      for (const [index, chunk] of grounding.groundingChunks.entries()) {
        if (!isRecord(chunk)) continue;
        const web = isRecord(chunk.web) ? chunk.web : undefined;
        if (typeof web?.uri === "string") {
          result.sources.push({
            index,
            title: typeof web.title === "string" && web.title.trim() ? web.title.trim() : web.uri,
            url: web.uri,
          });
        }
      }
    }
    if (Array.isArray(grounding.groundingSupports)) {
      const sourceIndices = new Set(result.sources.map((source) => source.index));
      const textPartIndices = new Set(result.parts?.map((part) => part.index));
      for (const support of grounding.groundingSupports) {
        if (!isRecord(support) || !isRecord(support.segment)) continue;
        if (
          typeof support.segment.text !== "string" ||
          !Array.isArray(support.groundingChunkIndices)
        )
          continue;
        const partIndex = support.segment.partIndex ?? 0;
        if (typeof partIndex !== "number" || !textPartIndices.has(partIndex)) continue;
        const indices = support.groundingChunkIndices.filter(
          (index): index is number =>
            typeof index === "number" && Number.isInteger(index) && sourceIndices.has(index),
        );
        if (indices.length === 0) continue;
        result.supports?.push({
          text: support.segment.text,
          startIndex:
            typeof support.segment.startIndex === "number" ? support.segment.startIndex : undefined,
          endIndex:
            typeof support.segment.endIndex === "number" ? support.segment.endIndex : undefined,
          partIndex:
            typeof support.segment.partIndex === "number" ? support.segment.partIndex : undefined,
          sourceIndices: indices,
        });
      }
    }
  }

  return result;
}

/** Google wraps each source in this host; its path is an opaque token, not a readable path. */
const GROUNDING_REDIRECT_HOST = "vertexaisearch.cloud.google.com";

/** Budget for one redirect resolution or page title fetch. */
const SOURCE_ENRICH_TIMEOUT_MS = 6_000;

/** Parallel enrichment requests per search. */
const SOURCE_ENRICH_CONCURRENCY = 6;

/** Upper bound on bytes read while looking for the page title. */
const PAGE_TITLE_BYTE_CAP = 64 * 1024;

const SOURCE_CACHE_LIMIT = 500;
const resolvedUrlCache = new Map<string, string>();
const pageTitleCache = new Map<string, string>();

function remember(map: Map<string, string>, key: string, value: string): void {
  if (map.size >= SOURCE_CACHE_LIMIT) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
  map.set(key, value);
}

/** Combined signal that still has a deadline when the caller supplied its own. */
function withDeadline(signal: AbortSignal | undefined, ms: number): AbortSignal {
  const timeout = AbortSignal.timeout(ms);
  if (!signal) return timeout;
  const anyFn = (AbortSignal as unknown as { any?: (signals: AbortSignal[]) => AbortSignal }).any;
  return anyFn ? anyFn([signal, timeout]) : signal;
}

function isBareDomainTitle(title: string): boolean {
  return /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(title);
}

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

/**
 * Readable path segment for a label, but never the grounding redirect path: that is an
 * opaque token, and using it produces labels that are all distinct yet say nothing.
 */
function readablePath(url: string | undefined): string {
  if (!url) return "";
  try {
    const parsed = new URL(url);
    if (
      parsed.hostname === GROUNDING_REDIRECT_HOST ||
      parsed.hostname.endsWith(`.${GROUNDING_REDIRECT_HOST}`)
    ) {
      return "";
    }
    const pathname = parsed.pathname.replace(/\/+$/, "");
    if (!pathname || pathname === "/" || pathname.includes("grounding-api-redirect")) return "";
    return pathname;
  } catch {
    return "";
  }
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;|&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Label shown inline at the claim and in the source list.
 *
 * A bare domain cannot distinguish several pages from one host (three `github.com`
 * entries), and a page title is not always usable either: some sites return only their
 * brand, so Reddit reports "Reddit" for every thread. Both cases fall back to
 * `host + readable path`.
 */
export function sourceLabel(source: SearchSource): string {
  // The chunk title is the real host; the raw url can be the opaque redirect host, which
  // must never surface as a label.
  const host = isBareDomainTitle(source.title)
    ? source.title.trim()
    : hostnameOf(source.resolvedUrl ?? source.url);
  const path = readablePath(source.resolvedUrl) || readablePath(source.url);
  const hostAndPath = path ? `${host}${path}` : host;

  const pageTitle = source.pageTitle?.trim();
  if (pageTitle) {
    const condensed = pageTitle.toLowerCase().replace(/[^a-z0-9]/g, "");
    const brand = host.replace(/^www\./, "").split(".")[0] ?? "";
    if (pageTitle.length >= 15 && condensed !== brand) return pageTitle;
  }

  if (source.title && !isBareDomainTitle(source.title)) return source.title;
  return hostAndPath;
}
/** Follow one grounding redirect without downloading the target page. */
async function resolveGroundingRedirect(url: string, signal?: AbortSignal): Promise<string> {
  try {
    const response = await antigravityFetch(url, {
      redirect: "manual",
      signal: withDeadline(signal, SOURCE_ENRICH_TIMEOUT_MS),
    });
    const location = response.headers.get("location");
    if (response.status >= 300 && response.status < 400 && location) return location;
  } catch {
    // Caller keeps the original redirect URL.
  }
  return "";
}

/** Read just enough of a page to recover its title; blocked or slow sites return empty. */
async function fetchPageTitle(url: string, signal?: AbortSignal): Promise<string> {
  if (!url || url.includes(GROUNDING_REDIRECT_HOST)) return "";
  try {
    const response = await antigravityFetch(url, {
      redirect: "follow",
      signal: withDeadline(signal, SOURCE_ENRICH_TIMEOUT_MS),
      headers: { "User-Agent": "Mozilla/5.0 (compatible; pi-antigravity/1.0)" },
    });
    if (!response.ok || !response.body) return "";
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (buffer.length < PAGE_TITLE_BYTE_CAP) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      if (/<\/head>/i.test(buffer)) break;
    }
    void reader.cancel().catch(() => {});
    const openGraph = buffer.match(
      /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)/i,
    )?.[1];
    const titleTag = buffer.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
    return decodeHtmlEntities(openGraph || titleTag || "");
  } catch {
    return "";
  }
}

/**
 * Add a real link and a readable label to every source.
 *
 * This exists because `groundingChunks[].web` carries only `uri` and `title`: no snippet,
 * no page title, and a title that is a bare domain almost every time. Without this step
 * a model reading the result cannot tell what any source is. Failures degrade to the
 * bare domain rather than to the opaque redirect URL.
 *
 * `ANTIGRAVITY_NO_SOURCE_ENRICH=1` skips it for callers that would rather not emit one
 * extra request per source.
 */
async function enrichSources(sources: SearchSource[], signal?: AbortSignal): Promise<void> {
  if (antigravityEnv("NO_SOURCE_ENRICH") === "1") {
    for (const source of sources) source.label = sourceLabel(source);
    return;
  }

  let cursor = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const position = cursor++;
      if (position >= sources.length) return;
      const source = sources[position];
      if (!source) continue;

      const redirect = source.url;
      if (!redirect.includes(GROUNDING_REDIRECT_HOST)) {
        source.resolvedUrl = redirect;
      } else {
        const cached = resolvedUrlCache.get(redirect);
        if (cached !== undefined) {
          source.resolvedUrl = cached;
        } else {
          const resolved = await resolveGroundingRedirect(redirect, signal);
          if (resolved) {
            remember(resolvedUrlCache, redirect, resolved);
            source.resolvedUrl = resolved;
          }
        }
      }

      const target = source.resolvedUrl ?? source.url;
      const cachedTitle = pageTitleCache.get(target);
      if (cachedTitle !== undefined) {
        source.pageTitle = cachedTitle;
      } else {
        const title = await fetchPageTitle(target, signal);
        if (title) {
          remember(pageTitleCache, target, title);
          source.pageTitle = title;
        }
      }

      source.label = sourceLabel(source);
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(SOURCE_ENRICH_CONCURRENCY, sources.length) }, () => worker()),
  );
}

function escapeLinkText(text: string): string {
  return text.replace(/[[\]]/g, "\\$&").replace(/\s+/g, " ");
}

/** One contiguous claim, carrying every source index that supports it. */
type CitationSpan = { start: number; end: number; indices: number[] };

type LineKind = "text" | "skip" | "table-row";
type LineInfo = { start: number; end: number; kind: LineKind; pipeAt?: number };

/**
 * Classify every line so citations never land in prose-hostile places.
 *
 * Google attaches supports to Markdown headings too, which would produce
 * `### Single-Writer Rule[1,2]` noise, and a marker appended after a table row's final
 * `|` adds a phantom column. Fenced code needs protecting for the same reason.
 */
function analyzeLines(text: string): LineInfo[] {
  const raw = text.split("\n");
  const lines: LineInfo[] = [];
  let offset = 0;
  let inFence = false;
  for (let index = 0; index < raw.length; index++) {
    const line = raw[index] ?? "";
    const start = offset;
    const end = start + line.length;
    offset = end + 1;

    let kind: LineKind = "text";
    let pipeAt: number | undefined;
    const isTableLine = (value: string): boolean => /^\s*\|?[\s:|-]*-[\s:|-]*\|/.test(value);

    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      kind = "skip";
    } else if (inFence) {
      kind = "skip";
    } else if (/^\s*#{1,6}\s/.test(line)) {
      kind = "skip";
    } else if (line.trim().startsWith("|")) {
      const next = raw[index + 1] ?? "";
      if (isTableLine(line) || isTableLine(next)) {
        kind = "skip"; // separator or header row: a marker here breaks the table
      } else {
        const lastPipe = line.lastIndexOf("|");
        kind = "table-row";
        pipeAt = lastPipe > 0 ? start + lastPipe : end;
      }
    }
    lines.push({ start, end, kind, pipeAt });
  }
  return lines;
}

function lineAt(lines: LineInfo[], position: number): LineInfo | undefined {
  return lines.find((line) => position >= line.start && position <= line.end);
}

/** Drop spans contained in a larger span, then merge overlapping ones, so one claim gets one marker. */
function mergeCitationSpans(spans: CitationSpan[]): CitationSpan[] {
  const sorted = [...spans].sort((a, b) => a.start - b.start || b.end - a.end);
  const kept: CitationSpan[] = [];
  for (const span of sorted) {
    const container = kept.find((other) => other.start <= span.start && other.end >= span.end);
    if (container) {
      container.indices = [...new Set([...container.indices, ...span.indices])].sort(
        (a, b) => a - b,
      );
      continue;
    }
    kept.push({ start: span.start, end: span.end, indices: [...span.indices] });
  }
  const merged: CitationSpan[] = [];
  for (const span of kept) {
    const previous = merged[merged.length - 1];
    if (previous && span.start <= previous.end) {
      previous.end = Math.max(previous.end, span.end);
      previous.indices = [...new Set([...previous.indices, ...span.indices])].sort((a, b) => a - b);
      continue;
    }
    merged.push({ ...span });
  }
  return merged;
}

/**
 * Map each UTF-8 byte offset in `text` to the JS character index it starts at.
 * Keep in sync with the byte-based verification below.
 */
function buildByteToCharMap(text: string): number[] {
  const map: number[] = [];
  for (let index = 0; index < text.length;) {
    const codePoint = text.codePointAt(index) as number;
    const width = codePoint > 0xffff ? 2 : 1;
    const byteLength = Buffer.byteLength(text.slice(index, index + width), "utf8");
    for (let byte = 0; byte < byteLength; byte++) map.push(index);
    index += width;
  }
  map.push(text.length);
  return map;
}

/**
 * Google's offsets are UTF-8 bytes within a content Part, not JS character indices.
 *
 * Each segment is verified byte-for-byte before use. A segment whose bytes do not match
 * its reported text is relocated by searching the part instead of being discarded: the
 * offsets drift on some answers (table-heavy ones in particular), and dropping those
 * citations silently removes exactly the provenance this function exists to provide.
 *
 * Markers are grouped per insertion point. The first mention of a source carries both its
 * number and a full link, so the number always matches its entry in the source list below and
 * the reader never has to resolve an unexplained `[n]`.
 */
function citeSearchText(res: SearchResult): string {
  if (!res.supports?.length) return res.text;
  const textParts = res.parts ?? [{ index: 0, text: res.text }];
  // Respect callers editing result.text; original offsets no longer apply.
  if (textParts.map((part) => part.text).join("\n\n") !== res.text) {
    return res.text;
  }

  const bySourceIndex = new Map<number, { number: number; label: string; url: string }>();
  res.sources.forEach((source, position) => {
    const sourceIndex = source.index ?? position;
    bySourceIndex.set(sourceIndex, {
      number: sourceIndex + 1,
      label: sourceLabel(source),
      url: source.resolvedUrl ?? source.url,
    });
  });

  const seen = new Set<number>();
  const insertionsByPart = new Map<number, Array<{ at: number; text: string }>>();

  for (const part of textParts) {
    const bytes = Buffer.from(part.text, "utf8");
    const byteToChar = buildByteToCharMap(part.text);
    const lines = analyzeLines(part.text);
    const spans: CitationSpan[] = [];

    for (const support of res.supports ?? []) {
      if ((support.partIndex ?? 0) !== part.index) continue;
      const indices = support.sourceIndices.filter((index) => bySourceIndex.has(index));
      if (indices.length === 0) continue;

      let start = support.startIndex;
      let end = support.endIndex;
      const offsetsTrustworthy =
        typeof start === "number" &&
        typeof end === "number" &&
        Number.isInteger(start) &&
        Number.isInteger(end) &&
        start >= 0 &&
        end > start &&
        end <= bytes.length &&
        bytes.subarray(start, end).toString("utf8") === support.text;

      if (!offsetsTrustworthy) {
        const located = part.text.indexOf(support.text);
        if (located < 0) continue;
        start = Buffer.byteLength(part.text.slice(0, located), "utf8");
        end = start + Buffer.byteLength(support.text, "utf8");
      }

      const startChar = byteToChar[start as number] ?? part.text.length;
      const endChar = byteToChar[end as number] ?? part.text.length;
      if (endChar <= startChar) continue;
      spans.push({
        start: startChar,
        end: endChar,
        indices: [...new Set(indices)].sort((a, b) => a - b),
      });
    }

    for (const span of mergeCitationSpans(spans)) {
      const line = lineAt(lines, span.end);
      if (!line || line.kind === "skip") continue;
      const at = line.kind === "table-row" ? (line.pipeAt ?? span.end) : span.end;
      const pieces = span.indices.map((index) => {
        const source = bySourceIndex.get(index);
        if (!source) return "";
        if (seen.has(index)) return `[${source.number}]`;
        seen.add(index);
        // The first mention carries the number too, so it matches the sources list below.
        return `[${source.number}] [${escapeLinkText(source.label)}](${source.url})`;
      });
      const text = ` ${pieces.filter(Boolean).join(" ")}`;
      const list = insertionsByPart.get(part.index) ?? [];
      list.push({ at, text });
      insertionsByPart.set(part.index, list);
    }
  }

  const rendered = textParts.map((part) => {
    let text = part.text;
    for (const insertion of (insertionsByPart.get(part.index) ?? []).sort((a, b) => b.at - a.at)) {
      text = text.slice(0, insertion.at) + insertion.text + text.slice(insertion.at);
    }
    return text;
  });

  return rendered.join("\n\n") || res.text;
}

/**
 * Formats structured SearchResult into clean Markdown for agent consumption.
 *
 * @param res - Structured search result containing text, sources, and executed queries.
 * @returns Formatted markdown string.
 */
export function formatSearchResult(res: SearchResult): string {
  const sections: string[] = [];

  const cited = citeSearchText(res);
  if (cited) sections.push(cited);

  if (res.sources.length > 0) {
    const list = res.sources
      .map((s, index) => {
        const number = res.supports?.length ? `[${(s.index ?? index) + 1}] ` : "";
        const url = s.resolvedUrl ?? s.url;
        return `- ${number}[${escapeLinkText(sourceLabel(s))}](${url})`;
      })
      .join("\n");
    sections.push(`### Sources\n${list}`);
  }

  if (res.queries.length > 0) {
    const queries = res.queries.map((q) => `\`${q}\``).join(", ");
    sections.push(`*Search queries: ${queries}*`);
  }

  return sections.join("\n\n");
}

/**
 * Execute real-time Google Search grounding via Antigravity backend with automatic fallback.
 *
 * @param options - Execution options containing query, API credentials, and optional directives.
 * @returns Markdown formatted search result with synthesis, citations, and search queries.
 */
export async function executeAntigravitySearch(options: ExecuteSearchOptions): Promise<string> {
  const query = options.query.trim();
  if (!query) throw new Error("Search query is required.");

  const creds = parseApiKey(options.apiKey);
  const headers = antigravityHeaders(creds.token);

  let lastError = "no endpoint available";

  for (const model of SEARCH_MODEL_FALLBACKS) {
    const body = JSON.stringify(buildSearchRequest(options, model, creds.projectId));

    for (const endpoint of endpointCandidates()) {
      if (options.signal?.aborted) throw new Error("Search request was aborted");

      try {
        const response = await antigravityFetch(`${endpoint}/v1internal:generateContent`, {
          method: "POST",
          headers,
          body,
          signal: options.signal,
        });

        if (!response.ok) {
          lastError = jsonOrTextError(await response.text()).slice(0, 400);
          if (response.status === 404 || [429, 500, 502, 503, 504].includes(response.status)) {
            continue; // Retry next endpoint for transient failures or missing model endpoints
          }
          // Fail fast on non-retryable client errors (e.g. 400 Bad Request, 401 Unauthorized, 403 Forbidden)
          throw Object.assign(new Error(lastError), { fatal: true });
        }

        const data: unknown = await response.json();
        const cand = firstUnknownItem(candidateList(data));

        const candidateText =
          isRecord(cand) && isRecord(cand.content) && Array.isArray(cand.content.parts)
            ? (cand.content.parts[0] as { text?: string })?.text
            : undefined;

        // Skip responses indicating deprecated model and move to next fallback model
        if (candidateText && candidateText.includes("is no longer available. Please switch")) {
          lastError = `Model ${model} deprecated: ${candidateText.slice(0, 100)}`;
          break;
        }

        const parsed = parseSearchResponse(data);
        await enrichSources(parsed.sources, options.signal);
        return formatSearchResult(parsed);
      } catch (error) {
        if (options.signal?.aborted) throw error;
        if (error instanceof Error && (error as { fatal?: boolean }).fatal) throw error;
        lastError = safeError(error).slice(0, 400);
      }
    }
  }

  throw new Error(`Antigravity Google Search failed: ${lastError}`);
}
