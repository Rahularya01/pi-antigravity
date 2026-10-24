/**
 * End-to-end test for the `read_url_content` tool.
 *
 * One flow: the real tool is registered, a mocked Google fetch service answers
 * the two RPCs the tool uses, and every scenario is checked through the output
 * the model receives — the header, the page text, the details, or the error.
 *
 * The suite is hermetic: it pins the service base URL, the character budget, and
 * the tool toggles, so an ambient environment cannot change the result.
 */
import strictAssert from "node:assert/strict";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import registerFetch from "../src/features/read-url-content.js";
import { isPrivateAddress } from "../src/search/index.js";
import { isRecord } from "../src/utils/util.js";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ENV_NAMES = [
  "ANTIGRAVITY_WEB_FETCH_MAX_CHARS",
  "NOAGY_WEB_FETCH_MAX_CHARS",
  "ANTIGRAVITY_BASE_URL",
  "NOAGY_BASE_URL",
  "ANTIGRAVITY_NO_EXTRA_TOOLS",
  "NOAGY_NO_EXTRA_TOOLS",
  "ANTIGRAVITY_NO_FETCH_TOOL",
  "NOAGY_NO_FETCH_TOOL",
];

type ServiceCall = { url: string; body: Record<string, unknown> };
type Handler = (body: Record<string, unknown>, url: string) => Response;

const calls: ServiceCall[] = [];
let handler: Handler = () => json({});

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** A complete, readable page. */
function article(body: string, extra = "", lang = "en"): string {
  return (
    `<!doctype html><html lang="${lang}"><head><title>Test page</title>${extra}</head>` +
    `<body><main><h1>Test page</h1><p>${body}</p></main></body></html>`
  );
}

/** The same page with its end cut off, so the tool looks for a better copy. */
function cutArticle(body: string, extra = "", lang = "en"): string {
  return (
    `<!doctype html><html lang="${lang}"><head><title>Test page</title>${extra}</head>` +
    `<body><main><h1>Test page</h1><p>${body}</p>`
  );
}

const saved = new Map(ENV_NAMES.map((name) => [name, process.env[name]]));
for (const name of ENV_NAMES) delete process.env[name];
process.env.ANTIGRAVITY_BASE_URL = "https://mock.googleapis.com";
// Saved pages land in a directory this suite removes; os.tmpdir() reads TMPDIR per call.
const previousTmp = process.env.TMPDIR;
const scratch = mkdtempSync(join(tmpdir(), "pi-url-test-"));
process.env.TMPDIR = scratch;

const originalFetch = globalThis.fetch;
globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input);
  const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
  calls.push({ url, body });
  return handler(body, url);
};

// --- the tool under test -----------------------------------------------------

type ToolResult = {
  content: Array<{ type: string; text: string }>;
  details: Record<string, unknown>;
};

let tool: Parameters<ExtensionAPI["registerTool"]>[0] | undefined;
let credentialReads = 0;
registerFetch({
  registerTool(definition) {
    // Only execute is exercised; renderer generic types are irrelevant to this host.
    tool = definition as typeof tool;
  },
});
strictAssert.ok(tool, "the read_url_content tool must register");
strictAssert.equal(tool.name, "read_url_content");
const schema: unknown = tool.parameters;
strictAssert.ok(isRecord(schema) && isRecord(schema.properties));
strictAssert.deepEqual(Object.keys(schema.properties), ["url"]);
strictAssert.deepEqual(schema.required, ["url"]);
strictAssert.match(tool.description, /no JavaScript execution/);
strictAssert.ok(tool.promptGuidelines?.some((line) => line.includes("local file")));

const apiKey = JSON.stringify({ token: "ya29.fixture-token", projectId: "fixture-project" });
const context = {
  modelRegistry: {
    async getApiKeyForProvider() {
      credentialReads += 1;
      return apiKey;
    },
  },
} as unknown as Parameters<NonNullable<typeof tool>["execute"]>[4];

type RunOptions = {
  /** Progress messages the tool emitted. */
  updates?: string[];
  /** Character budget for this call. */
  maxChars?: number;
};

async function read(url: string, options: RunOptions = {}): Promise<ToolResult> {
  const updates = options.updates ?? [];
  if (options.maxChars !== undefined)
    process.env.ANTIGRAVITY_WEB_FETCH_MAX_CHARS = String(options.maxChars);
  const params = { url };
  const result = await tool!.execute(
    "call",
    params,
    undefined,
    (update) => updates.push(JSON.stringify(update)),
    context,
  );
  return result as unknown as ToolResult;
}

function textOf(result: ToolResult): string {
  return result.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

/** The page body, without the provenance header and the saved-page footer. */
function bodyOf(result: ToolResult): string {
  const text = textOf(result);
  const separator = text.indexOf("\n\n---\n\n");
  const body = separator < 0 ? text : text.slice(separator + 7);
  const trailer = body.lastIndexOf("\n\n[Full page saved to: ");
  return trailer < 0 ? body : body.slice(0, trailer);
}

function attemptsOf(result: ToolResult): string[] {
  return ((result.details.attempts as Array<{ outcome: string }>) ?? []).map(
    (attempt) => attempt.outcome,
  );
}

// --- scenarios ----------------------------------------------------------------

/** The tool refuses unsafe targets before it asks the service for anything. */
async function scenarioGuards(): Promise<void> {
  calls.length = 0;
  const beforeCredentials = credentialReads;
  for (const url of [
    "http://127.0.0.1/",
    "http://10.1.2.3/",
    "http://[::1]/",
    "http://localhost/",
    "ftp://example.com/x",
    "https://user:supersecret@example.com/",
  ]) {
    await strictAssert.rejects(read(url), /private or local|Only http and https|credentials/);
  }
  strictAssert.equal(calls.length, 0, "a refused target must not reach the service");
  strictAssert.equal(
    credentialReads,
    beforeCredentials,
    "invalid targets must not consult credentials",
  );
  // A zone-scoped address is a local address; the scope does not make it public.
  strictAssert.equal(isPrivateAddress("fe80::1%eth0"), true);
  strictAssert.equal(isPrivateAddress("2606:4700::1111%eth0"), false);
}

/** A readable page arrives as markdown, with provenance; a long one is saved whole. */
async function scenarioReadablePage(): Promise<void> {
  const body = "The quick brown fox jumps over the lazy dog. ".repeat(200).trim();
  calls.length = 0;
  handler = (_body, url) =>
    url.endsWith(":rewriteUri") ? json({}) : json({ content: article(body) });
  const updates: string[] = [];
  const first = await read("https://example.com/page", { updates, maxChars: 1_000 });
  const text = textOf(first);
  strictAssert.ok(text.includes("Title: Test page"), "the header names the page");
  strictAssert.ok(
    text.includes("Source: https://example.com/page (cache)"),
    "the header cites the source",
  );
  strictAssert.equal(
    text.split("\n").filter((line) => line.startsWith("Source: ")).length,
    1,
    "metadata must not forge a second source line",
  );
  strictAssert.ok(
    text.length + JSON.stringify(first.details).length <= 1_000,
    "text and details share the budget",
  );
  strictAssert.equal(first.details.source, "cache");
  strictAssert.equal(first.details.truncated, true);
  strictAssert.deepEqual(Object.keys(first.details).sort(), [
    "assessment",
    "attempts",
    "bytes",
    "fullOutputPath",
    "omittedAttempts",
    "partial",
    "representationUrl",
    "source",
    "truncated",
  ]);

  // The whole page is on disk, private to the user, and the answer says where.
  const path = first.details.fullOutputPath as string;
  strictAssert.ok(path.startsWith(scratch), "the page is saved under the temp directory");
  strictAssert.ok(text.includes(`[Full page saved to: ${path} (`), "the answer names the file");
  const saved = readFileSync(path, "utf8");
  strictAssert.ok(saved.startsWith("Page metadata"), "the file keeps the provenance header");
  strictAssert.ok(saved.endsWith(`# Test page\n\n${body}`), "the file holds the whole page");
  strictAssert.equal(statSync(path).mode & 0o777, 0o600);
  strictAssert.ok(updates.some((update) => update.includes("Reading https://example.com/page")));

  // A page that fits is answered whole, without a file.
  const short = await read("https://example.com/short", { maxChars: 60_000 });
  strictAssert.equal(short.details.fullOutputPath, undefined);
  strictAssert.ok(!textOf(short).includes("Full page saved"));
}

/** A redirect is followed when it is usable, and refused when it is not. */
async function scenarioRedirects(): Promise<void> {
  calls.length = 0;
  handler = (_body, url) =>
    url.endsWith(":rewriteUri")
      ? json({ redirectUri: "/moved" })
      : json({ content: article("Moved content.") });
  const moved = await read("https://example.com/page");
  strictAssert.ok(textOf(moved).includes("Source: https://example.com/moved (cache)"));

  // A malformed or unsupported destination says nothing about the requested page.
  for (const redirectUri of ["https://exa mple.com/page"]) {
    calls.length = 0;
    handler = (_body, url) =>
      url.endsWith(":rewriteUri") ? json({ redirectUri }) : json({ content: article("Readable.") });
    const kept = await read("https://example.com/page");
    strictAssert.ok(bodyOf(kept).includes("Readable."));
    strictAssert.ok(textOf(kept).includes("Source: https://example.com/page (cache)"));
  }

  // A private destination fails closed, before the page is requested.
  calls.length = 0;
  handler = (_body, url) =>
    url.endsWith(":rewriteUri") ? json({ redirectUri: "http://127.0.0.1/" }) : json({});
  await strictAssert.rejects(read("https://example.com/page"), /private or local/);
  strictAssert.equal(calls.length, 1, "only the redirect lookup may happen");
}

/** A wall or a script shell is recovered live instead of being handed over. */
async function scenarioRecovery(): Promise<void> {
  const wall =
    "<!doctype html><html><head><title>Example</title></head><body><main>" +
    "<h1>Please enable JavaScript to continue</h1>" +
    "<p>Checking your browser before accessing example.com.</p></main></body></html>";
  calls.length = 0;
  handler = (body, url) =>
    url.endsWith(":rewriteUri")
      ? json({})
      : json({ content: body.liveFetch ? article("The real article.") : wall });
  const recovered = await read("https://example.com/page");
  strictAssert.ok(bodyOf(recovered).includes("The real article."));
  strictAssert.equal(recovered.details.source, "live");

  const shell =
    '<!doctype html><html><head><title>App</title></head><body><div id="root"></div>' +
    '<script src="/app.js"></script><p>Loading…</p></body></html>';
  calls.length = 0;
  handler = (body, url) =>
    url.endsWith(":rewriteUri")
      ? json({})
      : json({ content: body.liveFetch ? article("The real article.") : shell });
  const recoveredShell = await read("https://example.com/app");
  strictAssert.ok(bodyOf(recoveredShell).includes("The real article."));
  strictAssert.equal(recoveredShell.details.source, "live");
}

/** A page about a status code is an article, not an access wall. */
async function scenarioStatusArticle(): Promise<void> {
  calls.length = 0;
  handler = (_body, url) =>
    url.endsWith(":rewriteUri")
      ? json({})
      : json({
          content:
            "<!doctype html><html><head><title>429 Too Many Requests - HTTP | MDN</title></head>" +
            "<body><main><h1>429 Too Many Requests</h1>" +
            "<p>The client has sent too many requests in a given amount of time.</p>" +
            "</main></body></html>",
        });
  const article = await read("https://example.com/429");
  strictAssert.equal(article.details.assessment, "readable");
  strictAssert.ok(bodyOf(article).includes("too many requests in a given amount of time"));
}

/** A PDF is refused with guidance, however the service presents it. */
async function scenarioPdf(): Promise<void> {
  for (const respond of [
    () => json({ content: "preamble\n%PDF-1.7\nbinary" }),
    () => json({ content: "", contentType: "application/pdf" }),
  ]) {
    calls.length = 0;
    handler = (_body, url) => (url.endsWith(":rewriteUri") ? json({}) : respond());
    await strictAssert.rejects(
      read("https://example.com/download"),
      /does not support PDF content/,
    );
  }
  await strictAssert.rejects(read("https://example.com/paper.pdf"), /does not support PDF content/);

  // A live PDF behind a usable cached copy keeps the copy and says what happened.
  calls.length = 0;
  handler = (body, url) => {
    if (url.endsWith(":rewriteUri")) return json({});
    if (body.liveFetch) return json({ content: "%PDF-1.7\nbinary" });
    return json({ content: cutArticle("Cached article.") });
  };
  const retained = await read("https://example.com/download");
  strictAssert.ok(bodyOf(retained).includes("Cached article."));
  strictAssert.ok(
    attemptsOf(retained).some((outcome) => /unsupported PDF/.test(outcome)),
    "the attempt must not claim a plain HTTP 200",
  );
}

/** The advertised representation is used, and only the supported ones. */
async function scenarioAlternate(): Promise<void> {
  const links =
    '<link rel="alternate" type="text/markdown" href="/paper.pdf">' +
    '<link rel="alternate" type="text/markdown" href="/a.md" hreflang="en">';
  calls.length = 0;
  handler = (body, url) => {
    if (url.endsWith(":rewriteUri")) return json({});
    if (body.url === "https://example.com/a.md")
      return json({ content: "# Alternate\n\nThe alternate article." });
    return json({ content: cutArticle("Original article.", links, "en-US") });
  };
  const alternate = await read("https://example.com/page");
  strictAssert.ok(bodyOf(alternate).includes("The alternate article."));
  strictAssert.equal(alternate.details.representationUrl, "https://example.com/a.md");
  strictAssert.ok(
    !calls.some((call) => call.body.url === "https://example.com/paper.pdf"),
    "a PDF alternate is not fetched",
  );
  strictAssert.ok(
    !attemptsOf(alternate).some((outcome) => /alternate language/.test(outcome)),
    "a same-language representation is not a language mismatch",
  );
}

/** A decoded article field is not the JSON envelope's media type. */
async function scenarioJsonRepresentation(): Promise<void> {
  const links = '<link rel="alternate" type="application/json" href="/article.json">';
  const encoded = JSON.stringify({
    id: 1,
    link: "https://example.com/article",
    content: { rendered: "<p>Verified article body.</p>" },
  });
  for (const contentType of [undefined, "application/json"]) {
    calls.length = 0;
    handler = (body, url) => {
      if (url.endsWith(":rewriteUri")) return json({});
      if (body.url === "https://example.com/article.json")
        return json({ content: encoded, contentType });
      return json({ content: cutArticle("Original article.", links) });
    };
    const result = await read("https://example.com/article", { maxChars: 4000 });
    strictAssert.ok(bodyOf(result).includes("Verified article body."));
    strictAssert.ok(!bodyOf(result).includes("<p>"));
    strictAssert.ok(calls.length <= 5, "one publisher representation only");
  }
}

/** A later endpoint may still use the advertised representation. */
async function scenarioAlternateOnSecondEndpoint(): Promise<void> {
  delete process.env.ANTIGRAVITY_BASE_URL;
  const links = '<link rel="alternate" type="text/markdown" href="/a.md">';
  // The page itself holds no text, so the tool has to use the representation.
  const empty = `<!doctype html><html lang="en"><head><title>Test page</title>${links}</head><body><main>`;
  calls.length = 0;
  handler = (body, url) => {
    if (url.endsWith(":rewriteUri")) return json({});
    // Only transport failure triggers endpoint failover.
    if (url.includes("daily-cloudcode-pa.googleapis.com")) throw new TypeError("fetch failed");
    if (body.url === "https://example.com/a.md") {
      return json({ content: "# Alternate\n\nRecovered on a later endpoint." });
    }
    return json({ content: empty });
  };
  try {
    const result = await read("https://example.com/page");
    strictAssert.ok(bodyOf(result).includes("Recovered on a later endpoint."));
  } finally {
    process.env.ANTIGRAVITY_BASE_URL = "https://mock.googleapis.com";
  }
}

/** Transport failure on the representation does not repeat the original page. */
async function scenarioRepresentationTransport(): Promise<void> {
  delete process.env.ANTIGRAVITY_BASE_URL;
  const links = '<link rel="alternate" type="text/markdown" href="/body.md">';
  calls.length = 0;
  handler = (body, url) => {
    if (url.endsWith(":rewriteUri")) return json({});
    if (body.url === "https://example.com/body.md") {
      if (url.includes("daily-cloudcode-pa.googleapis.com")) throw new TypeError("fetch failed");
      return json({ content: "# Recovered\n\nRepresentation transport recovered." });
    }
    return json({ content: cutArticle("Original partial.", links) });
  };
  try {
    const result = await read("https://example.com/page", { maxChars: 4000 });
    strictAssert.ok(bodyOf(result).includes("Representation transport recovered."));
    strictAssert.equal(
      calls.filter((call) => call.body.url === "https://example.com/page").length,
      2,
    );
    strictAssert.ok(calls.length <= 10);
    const keys = calls.map((call) => JSON.stringify([call.url, call.body]));
    strictAssert.equal(new Set(keys).size, keys.length, "no endpoint/stage/URL is requested twice");
  } finally {
    process.env.ANTIGRAVITY_BASE_URL = "https://mock.googleapis.com";
  }
}

/** The cache saying "not here" leaves the live fetch to try. */
async function scenarioCacheMiss(): Promise<void> {
  calls.length = 0;
  handler = (body, url) => {
    if (url.endsWith(":rewriteUri")) return json({});
    if (body.liveFetch) return json({ content: article("Live article.") });
    return json({ error: { message: "gone" } }, 410);
  };
  const live = await read("https://example.com/page");
  strictAssert.ok(bodyOf(live).includes("Live article."));
  strictAssert.equal(live.details.source, "live");
}

/** Caller URLs are redacted on rendered surfaces, including a page echo. */
async function scenarioSecrets(): Promise<void> {
  calls.length = 0;
  handler = (body, url) =>
    url.endsWith(":rewriteUri") ? json({}) : json({ content: article("Echo " + String(body.url)) });
  const updates: string[] = [];
  const result = await read(
    "https://example.com/page?code=AUTHCODE&foo=ya29.TOKENSECRET#code=FRAGSECRET",
    { updates, maxChars: 4000 },
  );
  const visible = `${updates.join("")}\n${textOf(result)}\n${JSON.stringify(result.details)}`;
  strictAssert.ok(!visible.includes("AUTHCODE"), "an authorization code must be redacted");
  strictAssert.ok(!visible.includes("ya29.TOKENSECRET"), "a token must be redacted");
  strictAssert.ok(!visible.includes("FRAGSECRET"), "a fragment secret must be redacted");
  const sourceUrl = /^Source: (.+) \((?:cache|live)\)$/m.exec(textOf(result))?.[1];
  strictAssert.ok(sourceUrl);
  const source = new URL(sourceUrl);
  strictAssert.ok(source.searchParams.has("code"));
  strictAssert.ok(source.searchParams.has("foo"));
  strictAssert.notEqual(source.searchParams.get("code"), "AUTHCODE");
  strictAssert.ok(new URLSearchParams(source.hash.slice(1)).has("code"));
  strictAssert.ok(
    calls.some((call) => String(call.body.url).includes("AUTHCODE")),
    "the actual Google request is not redacted",
  );
}

/** A long URL cannot take the whole budget away from the page. */
async function scenarioBudget(): Promise<void> {
  calls.length = 0;
  handler = (_body, url) =>
    url.endsWith(":rewriteUri") ? json({}) : json({ content: article("Body.") });
  const long = `https://example.com/page?${"q=abcdefghij".repeat(150)}`;
  const result = await read(long, { maxChars: 1_000 });
  const text = textOf(result);
  strictAssert.ok(text.length <= 1_000, `output length ${text.length}`);
  strictAssert.ok(text.includes("Source: https://example.com/page"), "the source stays readable");
  strictAssert.ok(bodyOf(result).includes("Body."), "the page still reaches the model");
}

/** A code fence longer than the range cannot push the output over the budget. */
async function scenarioLongFence(): Promise<void> {
  calls.length = 0;
  handler = (_body, url) =>
    url.endsWith(":rewriteUri")
      ? json({})
      : json({ content: "```js " + "y".repeat(3_000) + "\nThe rest of the page.\n" });
  const result = await read("https://example.com/code", { maxChars: 1_000 });
  strictAssert.ok(textOf(result).length <= 1_000, "a long fence stays inside the budget");
}

/** Markup that is a page is read as a page; prose that mentions a tag is not. */
async function scenarioDetection(): Promise<void> {
  calls.length = 0;
  handler = (_body, url) =>
    url.endsWith(":rewriteUri")
      ? json({})
      : json({ content: '<a href="/a">A</a> <img src="/i.png"> <span>x</span> <b>y</b>' });
  const fragment = await read("https://example.com/fragment");
  strictAssert.ok(!bodyOf(fragment).includes("<a href"), "an inline fragment is markup, not text");
  strictAssert.ok(bodyOf(fragment).includes("A"));

  // A fragment that starts with an image is markup too.
  calls.length = 0;
  handler = (_body, url) =>
    url.endsWith(":rewriteUri") ? json({}) : json({ content: '<img src="/i.png">A caption.' });
  const image = await read("https://example.com/image");
  strictAssert.ok(!bodyOf(image).includes("<img"), "a fragment with an image is markup, not text");
  strictAssert.ok(bodyOf(image).includes("A caption."));

  calls.length = 0;
  handler = (_body, url) =>
    url.endsWith(":rewriteUri")
      ? json({})
      : json({ content: "<p> is the paragraph element, closed by </p>." });
  const prose = await read("https://example.com/prose");
  strictAssert.ok(
    bodyOf(prose).includes("<p> is the paragraph element"),
    "prose that starts with a tag is not markup",
  );

  // A comment in a style attribute must not hide the declaration behind it.
  calls.length = 0;
  handler = (_body, url) =>
    url.endsWith(":rewriteUri")
      ? json({})
      : json({
          content:
            "<!doctype html><html><body><main>" +
            "<p>Visible text</p>" +
            '<p style="/*x*/display:none">Hidden text</p>' +
            '<p style="display:none">Also hidden</p>' +
            "</main></body></html>",
        });
  const hidden = await read("https://example.com/hidden");
  strictAssert.ok(bodyOf(hidden).includes("Visible text"));
  strictAssert.ok(!bodyOf(hidden).includes("Hidden text"));
  strictAssert.ok(!bodyOf(hidden).includes("Also hidden"));
}

/** A copy that ends before the content is cut off, not an application shell. */
async function scenarioTruncatedCopy(): Promise<void> {
  calls.length = 0;
  handler = (_body, url) =>
    url.endsWith(":rewriteUri")
      ? json({})
      : json({
          content:
            '<!doctype html><html><head><title>App</title></head><body><main><script src="/app.js"></script>',
        });
  const truncated = await read("https://example.com/truncated");
  strictAssert.equal(
    truncated.details.assessment,
    "empty",
    "a copy that ends early is empty, not an application shell",
  );
  strictAssert.ok(
    attemptsOf(truncated).some((outcome) => /empty; source incomplete/.test(outcome)),
  );
}

/** An oversized response is refused once, not retried across every endpoint. */
async function scenarioOversized(): Promise<void> {
  calls.length = 0;
  handler = (_body, url) =>
    url.endsWith(":rewriteUri")
      ? json({})
      : new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new Uint8Array(5_000_001));
            },
          }),
        );
  await strictAssert.rejects(read("https://example.com/large"), /too large/);
  strictAssert.ok(calls.length <= 2, `expected at most two requests, saw ${calls.length}`);
}

/** Pages beyond the conversion limits are saved unconverted, not just refused. */
async function scenarioUnconverted(): Promise<void> {
  const secretUrl = "https://example.com/huge?access_token=SECRETVALUE";
  const html = `<html><body><main><p>${secretUrl}</p>${"<br>".repeat(60_000)}</main></body></html>`;
  calls.length = 0;
  handler = (_body, url) => (url.endsWith(":rewriteUri") ? json({}) : json({ content: html }));
  const error = await read(secretUrl).then(
    () => strictAssert.fail("an unconvertible page must not be returned as converted"),
    (caught: unknown) => caught as Error,
  );
  strictAssert.match(error.message, /too many elements to convert safely/);
  const path = /saved to: (\S+page\.html)\./.exec(error.message)?.[1];
  strictAssert.ok(path && path.startsWith(scratch), "the error names the saved copy");
  const kept = readFileSync(path, "utf8");
  strictAssert.ok(
    !kept.includes("SECRETVALUE"),
    "the saved copy must not hold the caller's secret",
  );
  strictAssert.equal(
    kept,
    html.replace(secretUrl, "https://example.com/huge?access_token=[redacted]"),
  );
  strictAssert.ok(!error.message.includes("SECRETVALUE"));
}

/** A save that fails is reported in the answer; the page that was read is not lost. */
async function scenarioSaveFailure(): Promise<void> {
  const body = "Words of the page. ".repeat(400);
  const original = process.env.TMPDIR;
  process.env.TMPDIR = join(scratch, "does-not-exist");
  try {
    handler = (_body, url) =>
      url.endsWith(":rewriteUri") ? json({}) : json({ content: article(body) });
    const long = await read("https://example.com/unsaved", { maxChars: 1_000 });
    strictAssert.ok(textOf(long).includes("could not be saved"), "the answer says the save failed");
    strictAssert.ok(bodyOf(long).includes("Words of the page."), "the page is still returned");
    strictAssert.equal(long.details.fullOutputPath, undefined);
    strictAssert.ok(textOf(long).length + JSON.stringify(long.details).length <= 1_000);

    const huge = "<html><body><main>" + "<br>".repeat(60_000) + "</main></body></html>";
    handler = (_body, url) => (url.endsWith(":rewriteUri") ? json({}) : json({ content: huge }));
    await strictAssert.rejects(
      read("https://example.com/unsaved-huge"),
      /too many elements to convert safely.*unconverted HTML .* could not be saved/s,
      "the page's own failure survives a failed save",
    );
  } finally {
    process.env.TMPDIR = original;
  }
}

/** A budget too small to answer fails before leaving a file behind. */
async function scenarioBudgetFailure(): Promise<void> {
  handler = (_body, url) =>
    url.endsWith(":rewriteUri") ? json({}) : json({ content: article("Body. ".repeat(500)) });
  const before = readdirCount();
  // 1 fails before saving; 300 and 400 fit the header but not the saved-page footer.
  for (const maxChars of [1, 300, 400]) {
    await strictAssert.rejects(
      read("https://example.com/budget-failure", { maxChars }),
      /budget is too small/,
    );
    strictAssert.equal(readdirCount(), before, `no file is left behind at ${maxChars}`);
  }
}

function readdirCount(): number {
  return readdirSync(scratch).length;
}

/** Wikipedia's cut-off article page recovers through its identity-checked parse API. */
async function scenarioWikipedia(): Promise<void> {
  const parse = (title: string, redirects: unknown[] = []) =>
    JSON.stringify({
      parse: {
        title,
        redirects,
        text: '<div class="mw-parser-output"><p>The Unix philosophy emphasizes small composable tools.</p></div>',
      },
    });
  const apiPage = (): string | undefined => {
    const api = calls.find((call) => String(call.body.url).includes("/w/api.php?"));
    return (api && new URL(String(api.body.url)).searchParams.get("page")) ?? undefined;
  };
  for (const [requested, answer, recovered, page] of [
    [
      "https://en.wikipedia.org/wiki/Unix_philosophy",
      parse("Unix philosophy"),
      true,
      "Unix_philosophy",
    ],
    // MediaWiki capitalizes the first letter, so this is the same article.
    [
      "https://en.wikipedia.org/wiki/unix_philosophy",
      parse("Unix philosophy"),
      true,
      "unix_philosophy",
    ],
    [
      "https://en.wikipedia.org/wiki/Unix_design",
      parse("Unix philosophy", [{ from: "Unix design", to: "Unix philosophy" }]),
      true,
      "Unix_design",
    ],
    // A title may contain slashes.
    ["https://en.wikipedia.org/wiki/AC/DC", parse("AC/DC"), true, "AC/DC"],
    [
      "https://en.wikipedia.org/wiki/Unix_philosophy",
      parse("Other article"),
      false,
      "Unix_philosophy",
    ],
    [
      "https://en.wikipedia.org/wiki/Unix_philosophy",
      parse("Unix philosophy").slice(0, -20),
      false,
      "Unix_philosophy",
    ],
  ] as const) {
    calls.length = 0;
    handler = (body, url) => {
      if (url.endsWith(":rewriteUri")) return json({});
      if (String(body.url).startsWith("https://en.wikipedia.org/w/api.php?"))
        return json({ content: answer });
      return json({ content: cutArticle("") });
    };
    const result = await read(requested, { maxChars: 4_000 });
    strictAssert.equal(
      bodyOf(result).includes("small composable tools"),
      recovered,
      recovered ? "the verified article is used" : "another or a cut-off article is never used",
    );
    if (recovered) strictAssert.equal(result.details.partial, false);
    strictAssert.equal(apiPage(), page);
  }
  // A revision, a search, and a special page are not the current article: no substitute.
  for (const unsupported of [
    "https://en.wikipedia.org/wiki/Unix_philosophy?oldid=1",
    "https://en.wikipedia.org/wiki/Special:Random",
  ]) {
    calls.length = 0;
    handler = (_body, url) =>
      url.endsWith(":rewriteUri") ? json({}) : json({ content: cutArticle("Cut copy.") });
    await read(unsupported, { maxChars: 4_000 });
    strictAssert.ok(
      !calls.some((call) => String(call.body.url).includes("/w/api.php")),
      `${unsupported} must not use the parse API`,
    );
  }
  // The article is recovered even when Google cannot serve the article page at all.
  calls.length = 0;
  handler = (body, url) => {
    if (url.endsWith(":rewriteUri")) return json({});
    if (String(body.url).includes("/w/api.php")) return json({ content: parse("Unix philosophy") });
    return json({ error: { code: 500, message: "Internal error encountered." } }, 500);
  };
  const unavailable = await read("https://en.wikipedia.org/wiki/Unix_philosophy", {
    maxChars: 4_000,
  });
  strictAssert.ok(bodyOf(unavailable).includes("small composable tools"));
}

/** A cut raw GitHub file recovers through the file page's own full line list. */
async function scenarioGithubRaw(): Promise<void> {
  const raw = "https://raw.githubusercontent.com/owner/repo/main/src/index.ts";
  const blob = "https://github.com/owner/repo/blob/main/src/index.ts";
  const lines = ["export const a = 1;", "export const b = 2;", "// the end of the file"];
  const page = (path: string, truncated = false) =>
    `<html><body><script type="application/json" data-target="react-app.embeddedData">${JSON.stringify(
      {
        payload: {
          codeViewBlobLayoutRoute: { path, blob: { truncated } },
          "codeViewBlobLayoutRoute.StyledBlob": { rawLines: lines },
        },
      },
    )}</script></body></html>`;
  for (const [file, recovered] of [
    [page("src/index.ts"), true],
    [page("src/other.ts"), false],
    [page("src/index.ts", true), false],
  ] as const) {
    calls.length = 0;
    handler = (body, url) => {
      if (url.endsWith(":rewriteUri")) return json({});
      if (body.url === blob) return json({ content: file });
      return json({ content: "export const a = 1;\nexport con" });
    };
    const result = await read(raw, { maxChars: 4_000 });
    strictAssert.equal(bodyOf(result).includes("// the end of the file"), recovered);
    if (recovered) strictAssert.equal(bodyOf(result), lines.join("\n"));
    strictAssert.ok(
      !calls.some((call) => call.url.endsWith(":rewriteUri") && call.body.originalUri === blob),
      "Google rewrites file pages back to raw, so the file page is not resolved",
    );
  }
  // The file is recovered even when Google cannot serve the raw URL at all.
  calls.length = 0;
  handler = (body, url) => {
    if (url.endsWith(":rewriteUri")) return json({});
    if (body.url === blob) return json({ content: page("src/index.ts") });
    return json({ error: { code: 500, message: "Internal error encountered." } }, 500);
  };
  const unavailable = await read(raw, { maxChars: 4_000 });
  strictAssert.equal(bodyOf(unavailable), lines.join("\n"));
}

/** /antigravity.fetch saves a long page too, and raw output is the source itself. */
async function scenarioCommand(): Promise<void> {
  const { default: register } = await import("../src/index.js");
  const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
  register({
    registerCommand: (
      name: string,
      definition: { handler: (args: string, ctx: unknown) => Promise<void> },
    ) => commands.set(name, definition),
    registerProvider() {},
    registerTool() {},
    on() {},
    getCommands: () => [],
  } as unknown as Parameters<typeof register>[0]);
  const output: string[] = [];
  const ctx = {
    hasUI: true,
    ui: { notify: (message: string) => output.push(message) },
    modelRegistry: {
      async getApiKeyForProvider() {
        return apiKey;
      },
    },
  };
  const source = article("Command page. ".repeat(500));
  handler = (_body, url) => (url.endsWith(":rewriteUri") ? json({}) : json({ content: source }));
  process.env.ANTIGRAVITY_WEB_FETCH_MAX_CHARS = "1000";
  const command = commands.get("antigravity.fetch")!;
  const savedPath = (): string => {
    const path = /saved to: (\S+page\.\w+) \(/.exec(output.at(-1) ?? "")?.[1];
    if (!path?.startsWith(scratch)) strictAssert.fail("the command output names a saved page");
    return path;
  };

  await command.handler("https://example.com/command", ctx);
  const converted = savedPath();
  strictAssert.ok(converted.endsWith("page.md"));
  strictAssert.ok(readFileSync(converted, "utf8").startsWith("Page metadata"));
  strictAssert.ok((output.at(-1) ?? "").length <= 1_000);

  // A cap that cannot hold the footer fails without leaving a saved page behind.
  const filesBefore = readdirCount();
  process.env.ANTIGRAVITY_WEB_FETCH_MAX_CHARS = "150";
  await command.handler("https://example.com/command-tiny", ctx);
  strictAssert.match(output.at(-1) ?? "", /budget is too small/);
  strictAssert.equal(readdirCount(), filesBefore);
  process.env.ANTIGRAVITY_WEB_FETCH_MAX_CHARS = "1000";

  await command.handler("--raw https://example.com/command-raw", ctx);
  const rawPath = savedPath();
  strictAssert.ok(rawPath.endsWith("page.html"));
  strictAssert.equal(readFileSync(rawPath, "utf8"), source, "raw output saves the source itself");
}

async function scenarioLifecycle(): Promise<void> {
  const controller = new AbortController();
  controller.abort();
  const before = { calls: calls.length, credentials: credentialReads };
  await strictAssert.rejects(
    tool!.execute(
      "aborted",
      { url: "https://example.com/" },
      controller.signal,
      undefined,
      context,
    ),
    /aborted/,
  );
  strictAssert.equal(calls.length, before.calls);
  strictAssert.equal(credentialReads, before.credentials);
  const delayedAbort = new AbortController();
  let progress = 0;
  const originalGetKey = context.modelRegistry.getApiKeyForProvider.bind(context.modelRegistry);
  context.modelRegistry.getApiKeyForProvider = async () => {
    delayedAbort.abort();
    return apiKey;
  };
  await strictAssert.rejects(
    tool!.execute(
      "cancel-during-auth",
      { url: "https://example.com/" },
      delayedAbort.signal,
      () => {
        progress += 1;
      },
      context,
    ),
    /aborted/,
  );
  context.modelRegistry.getApiKeyForProvider = originalGetKey;
  strictAssert.equal(
    progress,
    0,
    "a canceled read must not announce progress after credential lookup",
  );
}

// --- run ----------------------------------------------------------------------

try {
  await scenarioGuards();
  await scenarioReadablePage();
  await scenarioRedirects();
  await scenarioRecovery();
  await scenarioStatusArticle();
  await scenarioPdf();
  await scenarioAlternate();
  await scenarioJsonRepresentation();
  await scenarioAlternateOnSecondEndpoint();
  await scenarioRepresentationTransport();
  await scenarioCacheMiss();
  await scenarioSecrets();
  await scenarioBudget();
  await scenarioLongFence();
  await scenarioDetection();
  await scenarioTruncatedCopy();
  await scenarioOversized();
  await scenarioUnconverted();
  await scenarioSaveFailure();
  await scenarioBudgetFailure();
  await scenarioWikipedia();
  await scenarioGithubRaw();
  await scenarioCommand();
  await scenarioLifecycle();
  console.log(
    "read_url_content: end-to-end fetch, recovery, redaction and saved-page checks passed",
  );
} finally {
  globalThis.fetch = originalFetch;
  rmSync(scratch, { recursive: true, force: true });
  if (previousTmp === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = previousTmp;
  for (const [name, value] of saved) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}
