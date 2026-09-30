import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import { getGlobalDispatcher, MockAgent, setGlobalDispatcher } from "undici";
import { refreshAntigravityToken } from "../src/auth/oauth.js";

const credentials = {
  access: "old-access",
  refresh: "test-refresh",
  expires: 0,
  projectId: "test-project",
};
const tokenBody = gzipSync(
  JSON.stringify({ access_token: "new-access", expires_in: 3600, refresh_token: "new-refresh" }),
);
const originalFetch = globalThis.fetch;
const originalDispatcher = getGlobalDispatcher();
const mock = new MockAgent();
mock.disableNetConnect();
setGlobalDispatcher(mock);

// Reproduce the observed SDK-host failure: native fetch exposes compressed bytes
// without Content-Encoding, so Response.json() sees the gzip magic byte U+001F.
globalThis.fetch = (async () => new Response(tokenBody)) as typeof fetch;

try {
  await assert.rejects(
    (await globalThis.fetch("https://oauth2.googleapis.com/token")).json(),
    SyntaxError,
  );
  mock
    .get("https://oauth2.googleapis.com")
    .intercept({ path: "/token", method: "POST" })
    .reply(200, tokenBody, {
      headers: { "content-type": "application/json", "content-encoding": "gzip" },
    });

  const refreshed = await refreshAntigravityToken(credentials);
  assert.equal(refreshed.access, "new-access");
  assert.equal(refreshed.refresh, "new-refresh");
  assert.equal(refreshed.projectId, credentials.projectId);
  assert.ok(refreshed.expires > Date.now());

  mock
    .get("https://oauth2.googleapis.com")
    .intercept({ path: "/token", method: "POST" })
    .reply(400, gzipSync(JSON.stringify({ error: "invalid_grant" })), {
      headers: { "content-type": "application/json", "content-encoding": "gzip" },
    });
  await assert.rejects(refreshAntigravityToken(credentials), /invalid_grant/);
  mock.assertNoPendingInterceptors();
} finally {
  globalThis.fetch = originalFetch;
  setGlobalDispatcher(originalDispatcher);
  await mock.close();
}

console.log("OAuth fetch gzip success/error and shared dispatcher tests passed");
