import assert from "node:assert/strict";
import {
  getLastDiagnostics,
  resetDiagnosticsForTests,
  runWithDiagnostics,
  setLastEndpoint,
  setLastError,
  setLastStatus,
} from "../src/diagnostics/index.ts";
import {
  assertSafeApiBaseUrl,
  escapeHtml,
  escapeRegExp,
  redactSecrets,
  resolveCallbackHost,
} from "../src/utils/index.ts";

assert.equal(resolveCallbackHost("127.0.0.1"), "127.0.0.1");
assert.equal(resolveCallbackHost("localhost"), "127.0.0.1");
assert.equal(resolveCallbackHost("::1"), "::1");
assert.throws(() => resolveCallbackHost("0.0.0.0"), /loopback/i);
assert.throws(() => resolveCallbackHost("192.168.1.1"), /loopback/i);

assert.equal(
  assertSafeApiBaseUrl("https://cloudcode-pa.googleapis.com/"),
  "https://cloudcode-pa.googleapis.com",
);
assert.throws(() => assertSafeApiBaseUrl("http://cloudcode-pa.googleapis.com"), /https/i);
assert.throws(() => assertSafeApiBaseUrl("https://evil.example.com"), /not allowed/i);
assert.throws(
  () => assertSafeApiBaseUrl("https://user:pass@cloudcode-pa.googleapis.com"),
  /credentials/i,
);

assert.match(escapeHtml(`<script>alert("x")</script>`), /&lt;script&gt;/);
assert.equal(escapeRegExp("a.b*c?"), String.raw`a\.b\*c\?`);

const leaked = redactSecrets(
  'Bearer ya29.a0AfH6SMC-test token="ya29.abc" refresh_token=1/abcdefghijklmnopqrstuvwxyz12',
);
assert.doesNotMatch(leaked, /ya29\./);
assert.doesNotMatch(leaked, /1\/abcdefgh/);
assert.match(leaked, /\[redacted/);

resetDiagnosticsForTests();
await Promise.all([
  runWithDiagnostics(async () => {
    setLastEndpoint("https://a.example");
    setLastStatus(200);
    await new Promise((r) => setTimeout(r, 20));
    setLastError("error-a");
  }),
  runWithDiagnostics(async () => {
    setLastEndpoint("https://b.example");
    setLastStatus(429);
    await new Promise((r) => setTimeout(r, 5));
    setLastError("error-b");
  }),
]);

const last = getLastDiagnostics();
assert.ok(last.endpoint === "https://a.example" || last.endpoint === "https://b.example");
if (last.endpoint === "https://a.example") {
  assert.equal(last.status, 200);
  assert.equal(last.error, "error-a");
} else {
  assert.equal(last.status, 429);
  assert.equal(last.error, "error-b");
}

console.log("security-check: ok");
