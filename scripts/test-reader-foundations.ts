import assert from "node:assert/strict";
import { classifyFetchSmoke } from "./smoke-fetch-policy.js";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { executeAntigravityWebFetch, statusAction } from "../src/web-fetch/web-fetch.js";
import { getLastDiagnostics } from "../src/diagnostics/index.js";
import { parseApiKey } from "../src/client/client.js";
import { checkPublicUrl, isPrivateAddress } from "../src/utils/address.js";
import { redactSecrets } from "../src/utils/security.js";
import { cleanText, repairText, boundaryBack, boundaryForward } from "../src/utils/text.js";
import {
  parseDocument,
  DocumentLimitError,
  MAX_DOCUMENT_CHARS,
  MAX_DOCUMENT_NODES,
} from "../src/web-fetch/document.js";
import { inspectPage } from "../src/web-fetch/inspect.js";
import { htmlToMarkdown, looksLikeHtml } from "../src/web-fetch/markdown.js";
import { inspectMdnRepresentation } from "../src/web-fetch/mdn.js";
import { formatWebFetchHeader, type WebFetchResult } from "../src/web-fetch/web-fetch.js";
import { formatSearchResult } from "../src/search/search.js";

assert.equal(repairText("x\ud800\ny\udc00"), "x\ufffd\ny\ufffd");
assert.equal(cleanText("a\n\ud800\tb", 50), "a \ufffd b");
assert.equal(boundaryBack("a😀b", 2), 1);
assert.equal(boundaryForward("a😀b", 2), 3);
for (const limit of [1, 2, 3, 4]) {
  const value = cleanText("😀😀😀", limit)!;
  assert.ok(value.length <= limit);
  assert.equal(value, repairText(value));
}

for (const status of [204, 301, 404, 410]) assert.equal(statusAction("cache", status), "missing");
for (const stage of ["cache", "live", "representation"] as const) {
  assert.equal(statusAction(stage, 200), "content");
  for (const status of [401, 403]) assert.equal(statusAction(stage, status), "stop");
  for (const status of [429, 500, 503]) assert.equal(statusAction(stage, status), "recover");
}
assert.deepEqual(
  classifyFetchSmoke({
    found: false,
    canonicalObserved: true,
    assessment: "empty",
    partial: true,
    attempts: [{ source: "live", outcome: "HTTP 503" }],
  }),
  { status: "warn", insufficientCoverage: true },
);
assert.equal(
  classifyFetchSmoke({
    found: false,
    canonicalObserved: true,
    assessment: "readable",
    partial: false,
  }).status,
  "fail",
);
assert.deepEqual(
  classifyFetchSmoke({
    found: true,
    canonicalObserved: false,
    assessment: "readable",
    partial: null,
  }),
  { status: "warn", insufficientCoverage: false },
);
const longSecretJson = JSON.stringify({ secret: "x".repeat(10_000) });
assert.deepEqual(JSON.parse(redactSecrets(longSecretJson)), { secret: "[redacted]" });
assert.ok(!redactSecrets("https://user:password@part@host.example/").includes("password"));
assert.ok(
  !redactSecrets(
    "https://example.com/?redirect=https://other.example/?access_token=secret-value",
  ).includes("secret-value"),
);
const ordinary = "state=UNAVAILABLE code=429 session=expired key=one";
assert.equal(redactSecrets(ordinary), ordinary);
const redactedJson = redactSecrets(
  '{"token":"secret-value","state":"UNAVAILABLE","password":"a b"}',
);
assert.deepEqual(JSON.parse(redactedJson), {
  token: "[redacted]",
  state: "UNAVAILABLE",
  password: "[redacted]",
});
for (const secret of [
  "ya29.fixture",
  "1//" + "a".repeat(30),
  "4/0A" + "b".repeat(30),
  "GOCSPX-" + "c".repeat(30),
]) {
  assert.ok(!redactSecrets("value: " + secret).includes(secret));
}
for (const name of [
  "access_token",
  "subscription_key",
  "client-secret",
  "apiKey",
  "%61ccess_token",
]) {
  assert.ok(
    !redactSecrets("https://example.com/?" + name + "=secret-value").includes("secret-value"),
  );
}
assert.ok(
  !redactSecrets(
    "https://example.com/?next=" + encodeURIComponent("?access_token=secret-value"),
  ).includes("secret-value"),
);
for (const field of ["private_key", "oauth_consumer_key", "x-amz-credential", "api_key"])
  assert.ok(!redactSecrets(field + "=secret-value").includes("secret-value"));
assert.doesNotThrow(() => JSON.parse(redactSecrets('{"url":"https://example.com/?token=secret"}')));
assert.equal(redactSecrets("?".repeat(100_000)), "?".repeat(100_000));
assert.throws(
  () => parseApiKey('{"token":"do-not-echo'),
  (error: unknown) =>
    error instanceof Error &&
    !String(error.cause).includes("do-not-echo") &&
    !error.message.includes("do-not-echo"),
);
for (const value of [
  "null",
  "[]",
  '{"token":42,"projectId":"p"}',
  '{"token":"t","projectId":{}}',
  JSON.stringify({ token: "secret\nvalue", projectId: "p" }),
  JSON.stringify({ token: "t", projectId: "project\rvalue" }),
])
  assert.throws(() => parseApiKey(value), /Invalid Antigravity credentials/);

for (const address of [
  "192.0.0.1",
  "192.0.2.1",
  "198.51.100.1",
  "203.0.113.1",
  "::1",
  "64:ff9b:1::1",
  "2001:2::1",
  "3fff::1",
]) {
  assert.equal(isPrivateAddress(address), true, address);
}
for (const address of ["8.8.8.8", "2606:4700::1111", "::ffff:808:808", "::ffff:0:808:808"])
  assert.equal(isPrivateAddress(address), false, address);
for (const url of [
  "http://host/",
  "http://foo.localdomain/",
  "http://foo.test/",
  "https://u:p@example.com/",
  "javascript:alert(1)",
  "https://example.com/" + "x".repeat(2048),
])
  assert.equal(checkPublicUrl(url).ok, false, url.slice(0, 60));
assert.equal(checkPublicUrl("https://example.com/").ok, true);

const page = (body: string, title = "Test") =>
  "<!doctype html><html><head><title>" + title + "</title></head><body>" + body + "</body></html>";
for (const title of [
  "403 Forbidden",
  "401 Unauthorized",
  "Sign in with Google",
  "Just a moment in Rust async",
  "Security check in CI pipelines",
]) {
  const result = inspectPage(
    page(
      "<main><h1>" +
        title +
        "</h1><p>" +
        "An article explains this behavior. ".repeat(30) +
        "</p></main>",
      title,
    ),
    "https://example.com/",
  );
  assert.equal(result.assessment, "readable", title);
}
for (const title of [
  "403 Forbidden",
  "401 Unauthorized",
  "Sign in with Google",
  "Security check in CI pipelines",
])
  assert.equal(
    inspectPage(
      page("<main><h1>" + title + "</h1><p>Body.</p></main>", title),
      "https://example.com/",
    ).assessment,
    "readable",
    title,
  );
assert.equal(
  inspectPage(page("<main><h1>Only a heading</h1></main>"), "https://example.com/").assessment,
  "readable",
);
assert.equal(
  inspectPage(
    page("<main><h1>Robot or human?</h1><p>Verify to proceed.</p></main>"),
    "https://example.com/",
  ).assessment,
  "suspected-access-wall",
);
assert.ok(
  htmlToMarkdown(
    page("<main hidden>Nothing</main><article><h1>Real article</h1><p>Useful text.</p></article>"),
  ).includes("Useful text."),
);
assert.ok(
  htmlToMarkdown(
    page('<main><p>Useful.</p><div class="site-footer">Site chrome</div></main>'),
  ).includes("Useful."),
);
assert.ok(
  !htmlToMarkdown(
    page('<main><p>Useful.</p><div class="site-footer">Site chrome</div></main>'),
  ).includes("Site chrome"),
);
assert.equal(
  looksLikeHtml('<svg xmlns="http://www.w3.org/2000/svg"><text>hello</text></svg>'),
  false,
);
assert.equal(
  looksLikeHtml("<urlset><url><loc>https://example.com</loc></url></urlset>", "application/xml"),
  false,
);
assert.equal(looksLikeHtml("<p>Body.</p> Advertisement."), true);
assert.equal(looksLikeHtml("<div>Body</div> More text"), true);
assert.equal(looksLikeHtml("<root><entry>XML</entry></root>"), false);
assert.equal(looksLikeHtml("<p> is the paragraph element, closed by </p>."), false);
assert.equal(looksLikeHtml(page("<p>Visible.</p>"), "text/plain"), true);
assert.equal(
  inspectPage("# Header\n\n\ud800", "https://example.com/").rendered,
  "# Header\n\n\ufffd",
);

assert.throws(
  () => parseDocument("<div>".repeat(2000) + "Text" + "</div>".repeat(2000)),
  /nested too deeply/,
);
assert.throws(() => parseDocument("x".repeat(MAX_DOCUMENT_CHARS + 1)), /too large/);
assert.throws(() => parseDocument("<br>".repeat(MAX_DOCUMENT_NODES + 1)), /too many elements/);
parseDocument(page("<ul>" + "<li><p>Item".repeat(1000) + "</ul>"));
parseDocument(
  page(
    "<script>" +
      "<div>".repeat(5000) +
      "</script><!--" +
      "<div>".repeat(5000) +
      "--><p>Visible.</p>",
  ),
);
assert.ok(
  !htmlToMarkdown(
    page(
      '<main><p>Useful.</p><section class="content-section article-footer">Report a problem with this content</section></main>',
    ),
  ).includes("Report a problem"),
);
// Utility layout classes are not chrome, and a wrapper holding the content root stays.
for (const className of ["lg:grid-cols-sidebar-content", "page-sidebar"]) {
  const rendered = htmlToMarkdown(
    page(
      '<div class="' +
        className +
        '"><main><h1>Quick Start</h1><p>Layout-wrapped article body.</p></main></div>',
    ),
  );
  assert.ok(rendered.includes("Layout-wrapped article body."), className);
}
assert.ok(
  !htmlToMarkdown(
    page('<main><p>Useful.</p><div class="site-sidebar">Related links</div></main>'),
  ).includes("Related links"),
);
// A cut-off copy that holds only the title has lost its body.
const cutOff = inspectPage(
  "<!doctype html><html><head><title>T</title></head><body><main><h1>Unix philosophy</h1>",
  "https://example.com/",
);
assert.equal(cutOff.completeness, "incomplete");
assert.equal(cutOff.assessment, "empty");
// Large reference pages convert: RFC-sized markup fits the work limits.
const reference = page(
  "<main>" +
    (
      "<section><h2>Section</h2><p>" +
      "Reference text. ".repeat(12) +
      "<a href=/x>a link</a> and <code>code</code>.</p></section>"
    ).repeat(3_000) +
    "</main>",
);
assert.ok(reference.length > 512_000);
assert.ok(htmlToMarkdown(reference).includes("## Section"));
// Tag names the parser accepts but the DOM refuses to clone no longer fail the read.
for (const markup of ["<a<a>x</a>", "<p<p>x", "<z:a<b>x</z:a<b>", '<a<a href="/x">x</a>']) {
  const rendered = htmlToMarkdown(page("<main><p>Useful text.</p>" + markup + "</main>"));
  assert.ok(rendered.includes("Useful text.") && rendered.includes("x"), markup);
}
// Layout and state classes on a wrapper that holds the article do not delete it.
const article = "<h1>Heading</h1><p>" + "Substantive article sentence. ".repeat(30) + "</p>";
for (const className of [
  "has-sidebar",
  "menu-open",
  "nav-open",
  "with-toc",
  "content-sidebar-wrap",
  "footer-wrap",
]) {
  const rendered = htmlToMarkdown(
    page('<div class="' + className + '"><div class="post">' + article + "</div></div>"),
  );
  assert.ok(rendered.includes("Substantive article sentence."), className);
}
// A utility class describes layout, even on a short, unheaded page.
assert.ok(
  htmlToMarkdown(
    page('<div class="lg:grid-cols-sidebar-content"><p>Short article.</p></div>'),
  ).includes("Short article."),
);
// No heading needed: a wrapper that is most of the page's text is the page.
assert.ok(
  htmlToMarkdown(
    page('<div class="has-sidebar"><p>' + "Plain paragraph text only. ".repeat(40) + "</p></div>"),
  ).includes("Plain paragraph text only."),
);
assert.ok(
  !htmlToMarkdown(
    page('<div class="post">' + article + '</div><div class="sidebar">Related links</div>'),
  ).includes("Related links"),
);
// The page's <base href> decides where relative links point.
assert.ok(
  htmlToMarkdown(
    page('<p><a href="rel/x">a link</a></p>').replace(
      "<head>",
      '<head><base href="https://other.example/dir/">',
    ),
    { baseUrl: "https://example.com/post/" },
  ).includes("(https://other.example/dir/rel/x)"),
);
assert.throws(
  () => parseDocument("x".repeat(MAX_DOCUMENT_CHARS + 1)),
  (error: unknown) => error instanceof DocumentLimitError,
);
const manyBlocks = Array.from(
  { length: 2000 },
  (_, i) => "<h2>Section " + i + "</h2><p>Body " + i + ' with <a href="/link">a link</a>.</p>',
).join("");
const converted = htmlToMarkdown(page("<main>" + manyBlocks + "</main>"));
assert.ok(converted.includes("## Section 1999"));
assert.ok(converted.includes("[a link](/link)"));

const mdn = inspectMdnRepresentation(
  JSON.stringify({
    doc: {
      title: "Title\n\ud800",
      locale: "en-US\nforged",
      mdn_url: "/en-US/docs/Test",
      body: [
        { type: "prose", value: { content: "<p>Real prose.</p>" } },
        { type: "interactive-example", value: {} },
      ],
    },
  }),
  "https://developer.mozilla.org/en-US/docs/Test",
);
assert.ok(mdn);
assert.ok(mdn.html.includes("Real prose."));
assert.equal(mdn.completeness, "incomplete");
assert.ok(mdn.notes[0].includes("interactive-example"));
assert.equal(mdn.metadata.language, "en-US forged");

const captured: WebFetchResult = {
  requestedUrl: "https://example.com/",
  resolvedUrl: "https://example.com/",
  content: "",
  bytes: 0,
  partial: null,
  source: "cache",
  truncated: false,
};
const redirected = {
  ...captured,
  requestedUrl: "https://example.com/" + "a".repeat(500) + "b",
  resolvedUrl: "https://example.com/" + "a".repeat(500) + "c",
  maxChars: 1000,
};
assert.ok(formatWebFetchHeader(redirected).includes("Requested:"));
const search = formatSearchResult({
  text: "Result",
  sources: [{ title: "Source", url: "https://example.com/?token=secret-value" }],
  queries: [],
});
assert.ok(!search.includes("secret-value"));
const fixtures: Array<[string, string, string, string?]> = [
  ["first-website", "World Wide Web", "complete"],
  ["iana-http-status-codes.xhtml", "Status Code Registry", "complete"],
  ["mdn-status-page", "HTTP response status codes", "complete"],
  ["nasa-artemis-heat-shield", "Heat Shield", "complete"],
  ["python-urllib-request", "urllib.request", "incomplete"],
  ["rfc9110-excerpt", "HTTP Semantics", "incomplete"],
  ["wikipedia-artemis-ii", "Artemis II", "incomplete"],
  ["javadoc-string", "String", "incomplete"],
  ["nist-sp800-53r5", "53", "complete"],
  ["tldp-howto", "Unix and Internet", "unknown"],
  ["github-docs-hello-world", "", "incomplete", "empty"],
  ["mdn-status-shell", "", "unknown", "suspected-shell"],
  ["spacejam", "", "incomplete", "empty"],
];
for (const [name, marker, completeness, assessment = "readable"] of fixtures) {
  const file = name.endsWith(".xhtml") ? name + ".gz" : name + ".html.gz";
  const source = gunzipSync(
    readFileSync(new URL("./fixtures/web-fetch/" + file, import.meta.url)),
  ).toString("utf8");
  const result = inspectPage(source, "https://example.com/");
  assert.equal(result.assessment, assessment, name);
  assert.equal(result.completeness, completeness, name);
  assert.ok(result.rendered.includes(marker), name);
}
// A short injected deadline exercises the same shared signal without a ten-second test.
const originalFetch = globalThis.fetch;
const originalEndpoint = process.env.ANTIGRAVITY_BASE_URL;
process.env.ANTIGRAVITY_BASE_URL = "https://mock.googleapis.com";
const observedSignals = new Set<AbortSignal>();
let networkCalls = 0;
globalThis.fetch = async (input, init) => {
  networkCalls += 1;
  const signal = init?.signal;
  assert.ok(signal);
  observedSignals.add(signal);
  const body = JSON.parse(String(init?.body)) as { liveFetch?: boolean };
  if (!body.liveFetch)
    return new Response(
      JSON.stringify(
        String(input).endsWith(":rewriteUri")
          ? {}
          : { content: "<html><body><main><p>Useful partial content.</p>" },
      ),
    );
  await new Promise<void>((_resolve, reject) => {
    if (signal.aborted) reject(new Error("aborted"));
    else signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    // AbortSignal.timeout alone is unref'ed; hold a bounded timer for the fixture.
    setTimeout(() => reject(new Error("fixture exceeded its deadline")), 200);
  });
  throw new Error("unreachable");
};
try {
  const result = await executeAntigravityWebFetch({
    url: "https://example.com/deadline",
    apiKey: JSON.stringify({ token: "fixture", projectId: "fixture" }),
    timeoutMs: 30,
    maxChars: 10_000,
  });
  assert.ok(result.content.includes("Useful partial content."));
  assert.equal(networkCalls, 3);
  assert.equal(observedSignals.size, 1);
  assert.match(getLastDiagnostics().error ?? "", /Degraded fetch/);
  assert.ok((getLastDiagnostics().latencyMs ?? 1000) < 1000);
  const controller = new AbortController();
  controller.abort();
  const before = networkCalls;
  await assert.rejects(
    executeAntigravityWebFetch({
      url: "https://example.com/aborted",
      apiKey: JSON.stringify({ token: "fixture", projectId: "fixture" }),
      signal: controller.signal,
    }),
    /aborted/,
  );
  assert.equal(networkCalls, before);
} finally {
  globalThis.fetch = originalFetch;
  if (originalEndpoint === undefined) delete process.env.ANTIGRAVITY_BASE_URL;
  else process.env.ANTIGRAVITY_BASE_URL = originalEndpoint;
}
// Raw mode returns the crawled source whatever its size; converted output refuses it.
{
  const source =
    "<!doctype html><html><head><title>T</title></head><body><main>" +
    "<p>text</p>".repeat(250_000) +
    "</main></body></html>";
  assert.ok(source.length > MAX_DOCUMENT_CHARS);
  const original = globalThis.fetch;
  const originalBase = process.env.ANTIGRAVITY_BASE_URL;
  process.env.ANTIGRAVITY_BASE_URL = "https://mock.googleapis.com";
  globalThis.fetch = async (input) =>
    new Response(
      String(input).endsWith(":rewriteUri") ? "{}" : JSON.stringify({ content: source }),
      {
        headers: { "content-type": "application/json" },
      },
    );
  try {
    const key = JSON.stringify({ token: "fixture", projectId: "fixture" });
    const url = "https://example.com/huge-raw";
    const raw = await executeAntigravityWebFetch({
      apiKey: key,
      url,
      raw: true,
      maxChars: 5_000_000,
    });
    assert.equal(raw.content, source);
    assert.ok(raw.notes?.some((note) => note.includes("Not converted")));
    await assert.rejects(
      executeAntigravityWebFetch({ apiKey: key, url, maxChars: 5_000_000 }),
      /too large to convert safely/,
    );
  } finally {
    globalThis.fetch = original;
    if (originalBase === undefined) delete process.env.ANTIGRAVITY_BASE_URL;
    else process.env.ANTIGRAVITY_BASE_URL = originalBase;
  }
}
console.log(
  "reader foundations: text, credentials, URL policy, inspection, work bounds, and MDN passed",
);
