import assert from "node:assert/strict";
import {
  assertSafeApiBaseUrl,
  escapeHtml,
  escapeRegExp,
  redactSecrets,
  resolveCallbackHost,
} from "../src/oauth.ts";

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

console.log("security-check: ok");
