// Opt-in integration check: real tool handler, credentials, and Google requests.
// Only the Pi host is minimal. No mocked fetches or saved page captures.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { classifyFetchSmoke, isUpstreamAvailabilityError } from "./smoke-fetch-policy.js";
import { readJson, authPath } from "./fs-json.mjs";
import { refreshAntigravityToken } from "../src/auth/index.js";
import { redactSecrets } from "../src/utils/index.js";
import registerFetch from "../src/features/read-url-content.js";

let stored;
try {
  stored = readJson(authPath())?.antigravity;
} catch {
  throw new Error("Could not read Pi credentials. Check PI_AUTH_PATH or run /login antigravity.");
}
if (!stored?.access || !stored?.refresh)
  throw new Error("No Antigravity OAuth credentials. Run /login antigravity first.");
let credentials = stored;
if (!(stored.expires > Date.now() + 60_000)) {
  try {
    credentials = await refreshAntigravityToken(stored);
  } catch {
    // Do not expose an OAuth response that could echo a stored token.
    throw new Error("Could not refresh Antigravity credentials. Run /login antigravity and retry.");
  }
}
const apiKey = JSON.stringify({
  token: credentials.access,
  projectId: credentials.projectId || stored.projectId,
});
let tool;
registerFetch({
  registerTool(definition) { tool = definition; },
  on() { return () => {}; },
});
if (!tool) throw new Error("Fetch tool is disabled. Check ANTIGRAVITY_NO_EXTRA_TOOLS / ANTIGRAVITY_NO_FETCH_TOOL.");
let credentialReads = 0;
const context = { modelRegistry: {
  async getApiKeyForProvider() { credentialReads += 1; return apiKey; },
} };
const cases = [
  ["static", "https://example.com/", "documentation examples"],
  ["GitHub Docs", "https://docs.github.com/en/get-started/using-github/hello-world", "Hello World"],
  ["MDN old path", "https://developer.mozilla.org/en-US/docs/Web/HTTP/Status/429", "Retry-After", "https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Status/429"],
];
const textOf = result => result.content.filter(part => part.type === "text").map(part => part.text).join("\n");
function pageText(result) {
  const text = textOf(result);
  const separator = text.indexOf("\n\n---\n\n");
  assert.ok(separator >= 0, "Missing page-content boundary");
  const body = text.slice(separator + 7);
  const trailer = body.lastIndexOf("\n\n[Full page saved to: ");
  return trailer < 0 ? body : body.slice(0, trailer);
}
const counts = { pass: 0, warn: 0, fail: 0 };
let savedChecked = false;
let insufficientCoverage = false;
let requests = 0;
const originalFetch = globalThis.fetch;
const previousCap = process.env.ANTIGRAVITY_WEB_FETCH_MAX_CHARS;
process.env.ANTIGRAVITY_WEB_FETCH_MAX_CHARS = "1000";
globalThis.fetch = (...args) => { requests += 1; return originalFetch(...args); };
try {
  for (const [label, url, expected, canonical] of cases) {
    const started = performance.now();
    try {
      const requestsBefore = requests;
      const result = await tool.execute(label, { url }, AbortSignal.timeout(30_000), undefined, context);
      const text = textOf(result);
      assert.ok(text.length + JSON.stringify(result.details).length <= 1000, "Text and details exceed the configured character cap");
      const details = result.details;
      assert.ok(requests > requestsBefore, "URL fetch did not use the observed transport");
      assert.ok(["cache", "live"].includes(details.source), "Missing retrieval provenance");
      assert.ok(Number.isSafeInteger(details.bytes) && details.bytes > 0, "Invalid source byte count");
      assert.ok([true, false, null].includes(details.partial), "Invalid completeness state");
      assert.match(text, /Source: https?:\/\//, "Missing source URL");
      if (details.assessment === "suspected-shell") assert.match(text, /Note:.*JavaScript-rendered/, "Missing shell explanation");
      else if (details.partial !== false) assert.match(text, /Note:.*(?:ends mid-page|no clear end marker|completeness is unknown)/, "Missing completeness warning");
      const canonicalObserved = !canonical || text.includes("Source: " + canonical + " ");
      if (canonical && canonicalObserved) {
        assert.ok(text.includes("Requested: " + url), "Missing MDN redirect provenance");
      }
      if (details.assessment !== "readable") assert.ok(text.includes(`Content assessment: ${details.assessment}`), "Missing content assessment");
      let available = pageText(result);
      if (details.assessment === "readable") assert.ok(available.trim(), "Readable result has no page content");
      if (details.fullOutputPath !== undefined) {
        // The full page is saved locally; reading it needs no network or credentials.
        const before = { requests, credentialReads };
        const saved = readFileSync(details.fullOutputPath, "utf8");
        assert.ok(text.includes(`[Full page saved to: ${details.fullOutputPath} (`), "Missing saved-page footer");
        assert.ok(saved.length > pageText(result).length, "Saved page is not larger than the shown range");
        assert.equal(requests, before.requests, "Reading the saved page made a network request");
        assert.equal(credentialReads, before.credentialReads, "Reading the saved page consulted credentials");
        available = saved;
        savedChecked = true;
      }
      const found = available.toLowerCase().includes(expected.toLowerCase());
      // Missing stable page markers fail. The resolver may not reveal the MDN canonical alias.
      const verdict = classifyFetchSmoke({ found, canonicalObserved, ...details });
      const status = verdict.status;
      insufficientCoverage ||= verdict.insufficientCoverage;
      counts[status] += 1;
      console.log(`${status.toUpperCase()} ${label}: ${Math.round(performance.now() - started)} ms; source=${details.source}; partial=${details.partial}; assessment=${details.assessment}; expected text ${found ? "found" : "not found"}${canonicalObserved ? "" : "; expected MDN canonical URL not observed"}`);
    } catch (error) {
      const message = redactSecrets(error instanceof Error ? error.message : String(error)).replaceAll(credentials.access, "[redacted]");
      const upstream = !(error instanceof assert.AssertionError) &&
        isUpstreamAvailabilityError(message);
      const status = upstream ? "warn" : "fail";
      counts[status] += 1;
      insufficientCoverage ||= upstream;
      console.log(`${status.toUpperCase()} ${label}: ${Math.round(performance.now() - started)} ms; ${message.slice(0, 300)}`);
    }
  }
} finally {
  globalThis.fetch = originalFetch;
  if (previousCap === undefined) delete process.env.ANTIGRAVITY_WEB_FETCH_MAX_CHARS;
  else process.env.ANTIGRAVITY_WEB_FETCH_MAX_CHARS = previousCap;
}
console.log(`Fetch smoke: ${counts.pass} passed, ${counts.warn} warnings, ${counts.fail} failed; saved page ${savedChecked ? "checked" : "not checked"}.`);
console.log("Live results vary; this check does not certify full-page coverage.");
// Distinguish a broken contract (1) from insufficient live coverage (2).
process.exitCode = counts.fail ? 1 : (insufficientCoverage || !counts.pass || !savedChecked) ? 2 : 0;
