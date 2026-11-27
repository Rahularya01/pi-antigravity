import assert from "node:assert/strict";
import { get as httpGet } from "node:http";
import {
  getGlobalDispatcher,
  MockAgent,
  ProxyAgent,
  setGlobalDispatcher,
} from "undici";
import {
  loginAntigravity,
  REDIRECT_URI,
  refreshAntigravityToken,
  type OAuthLoginCallbacks,
} from "../src/auth/oauth.js";

const proxyEnvNames = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
] as const;
const originalEnv = new Map(proxyEnvNames.map((name) => [name, process.env[name]]));
const originalExplicitProxy = process.env.ANTIGRAVITY_PROXY;
const originalLegacyExplicitProxy = process.env.NOAGY_PROXY;
const originalFetch = globalThis.fetch;
const originalDispatcher = getGlobalDispatcher();
const originalProxyDispatch = ProxyAgent.prototype.dispatch;
const proxyDispatches: string[] = [];
const proxyEnvDuringRequests: string[] = [];
const mock = new MockAgent();
mock.disableNetConnect();

try {
  process.env.ANTIGRAVITY_PROXY = "http://proxy-user:proxy-pass@127.0.0.1:7890";
  delete process.env.NOAGY_PROXY;
  for (const name of proxyEnvNames) {
    process.env[name] = "http://environment-proxy.invalid:8080";
  }
  const expectedEnvSnapshot = JSON.stringify(
    proxyEnvNames.map((name) => [name, "http://environment-proxy.invalid:8080"]),
  );

  const mockDispatch = mock.dispatch.bind(mock);
  mock.dispatch = (options, handler) => {
    proxyEnvDuringRequests.push(
      JSON.stringify(proxyEnvNames.map((name) => [name, process.env[name]])),
    );
    return mockDispatch(options, handler);
  };
  ProxyAgent.prototype.dispatch = function (options, handler) {
    proxyDispatches.push(`${options.method} ${options.origin}${options.path}`);
    return mock.dispatch(options, handler);
  };
  setGlobalDispatcher(mock);
  globalThis.fetch = (async () => {
    throw new Error("Unexpected native fetch while ANTIGRAVITY_PROXY is set");
  }) as typeof fetch;

  const tokenResponse = {
    access_token: "new-access",
    refresh_token: "new-refresh",
    expires_in: 3600,
  };
  mock
    .get("https://oauth2.googleapis.com")
    .intercept({ path: "/token", method: "POST" })
    .reply(200, tokenResponse, { headers: { "content-type": "application/json" } });
  mock
    .get("https://www.googleapis.com")
    .intercept({ path: "/oauth2/v1/userinfo?alt=json", method: "GET" })
    .reply(200, { email: "oauth-test@example.com" }, {
      headers: { "content-type": "application/json" },
    });
  mock
    .get("https://daily-cloudcode-pa.googleapis.com")
    .intercept({ path: "/v1internal:loadCodeAssist", method: "POST" })
    .reply(200, { projectId: "test-project" }, {
      headers: { "content-type": "application/json" },
    });
  mock
    .get("https://oauth2.googleapis.com")
    .intercept({ path: "/token", method: "POST" })
    .reply(200, tokenResponse, { headers: { "content-type": "application/json" } });

  const callbackAbort = new AbortController();
  const credentials = await loginAntigravity({
    onAuth({ url }) {
      const callbackUrl = new URL(REDIRECT_URI);
      callbackUrl.searchParams.set("code", "test-code");
      callbackUrl.searchParams.set("state", new URL(url).searchParams.get("state") || "");
      const request = httpGet(callbackUrl, (response) => {
        if (response.statusCode !== 200) {
          callbackAbort.abort(new Error(`Callback status ${response.statusCode}`));
        }
        response.resume();
      });
      request.on("error", (error) => callbackAbort.abort(error));
    },
    onDeviceCode() {
      throw new Error("Unexpected device-code callback");
    },
    async onSelect() {
      return undefined;
    },
    signal: callbackAbort.signal,
  } as OAuthLoginCallbacks);
  assert.equal(credentials.access, "new-access");
  assert.equal(credentials.email, "oauth-test@example.com");
  assert.equal(credentials.projectId, "test-project");

  const refreshed = await refreshAntigravityToken(credentials);
  assert.equal(refreshed.access, "new-access");
  assert.equal(refreshed.refresh, "new-refresh");

  const tokenRequest = "POST https://oauth2.googleapis.com/token";
  assert.equal(
    proxyDispatches.filter((request) => request === tokenRequest).length,
    2,
    "login token exchange and token refresh must both use the explicit proxy",
  );
  assert.ok(
    proxyDispatches.includes("GET https://www.googleapis.com/oauth2/v1/userinfo?alt=json"),
    "OAuth userinfo must use the explicit proxy",
  );
  assert.ok(
    proxyDispatches.includes(
      "POST https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist",
    ),
    "project discovery must use the same explicit proxy",
  );
  assert.equal(proxyDispatches.length, 4);
  assert.ok(proxyEnvDuringRequests.length > 0);
  assert.deepEqual(new Set(proxyEnvDuringRequests), new Set([expectedEnvSnapshot]));
  mock.assertNoPendingInterceptors();
} finally {
  globalThis.fetch = originalFetch;
  ProxyAgent.prototype.dispatch = originalProxyDispatch;
  setGlobalDispatcher(originalDispatcher);
  if (originalExplicitProxy === undefined) delete process.env.ANTIGRAVITY_PROXY;
  else process.env.ANTIGRAVITY_PROXY = originalExplicitProxy;
  if (originalLegacyExplicitProxy === undefined) delete process.env.NOAGY_PROXY;
  else process.env.NOAGY_PROXY = originalLegacyExplicitProxy;
  for (const name of proxyEnvNames) {
    const value = originalEnv.get(name);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  await mock.close();
}

console.log("OAuth and project discovery explicit ProxyAgent tests passed");
