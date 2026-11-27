import assert from "node:assert/strict";
import { getGlobalDispatcher, MockAgent, ProxyAgent, setGlobalDispatcher } from "undici";
import { antigravityFetch } from "../src/utils/http.js";

const proxyEnvNames = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
] as const;
const originalEnv = new Map(proxyEnvNames.map((name) => [name, process.env[name]]));
const originalFetch = globalThis.fetch;
const originalExplicitProxy = process.env.ANTIGRAVITY_PROXY;
const originalLegacyExplicitProxy = process.env.NOAGY_PROXY;
let requestInit: RequestInit | undefined;

for (const name of proxyEnvNames) delete process.env[name];
delete process.env.ANTIGRAVITY_PROXY;
delete process.env.NOAGY_PROXY;
process.env.HTTPS_PROXY = "socks5://127.0.0.1:1080";
globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
  requestInit = init;
  return new Response(null, { status: 204 });
}) as typeof fetch;

try {
  const response = await antigravityFetch("https://cloudcode-pa.googleapis.com", { method: "HEAD" });
  assert.equal(response.status, 204);
  assert.ok(requestInit);
  assert.equal("dispatcher" in requestInit, false);
} finally {
  globalThis.fetch = originalFetch;
  if (originalExplicitProxy === undefined) delete process.env.ANTIGRAVITY_PROXY;
  else process.env.ANTIGRAVITY_PROXY = originalExplicitProxy;
  if (originalLegacyExplicitProxy === undefined) delete process.env.NOAGY_PROXY;
  else process.env.NOAGY_PROXY = originalLegacyExplicitProxy;
  for (const name of proxyEnvNames) {
    const value = originalEnv.get(name);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

const originalDispatcher = getGlobalDispatcher();
const originalProxyDispatch = ProxyAgent.prototype.dispatch;
const originalProxyClose = ProxyAgent.prototype.close;
const explicitProxyDispatches: string[] = [];
const proxyAgents: ProxyAgent[] = [];
const closedProxyAgents: ProxyAgent[] = [];
const proxyEnvDuringRequests: string[] = [];
const mock = new MockAgent();
mock.disableNetConnect();
let nativeFetchCalls = 0;
let pauseNextProxyDispatch = false;
let notifyOldRequestStarted!: () => void;
const oldRequestStarted = new Promise<void>((resolve) => {
  notifyOldRequestStarted = resolve;
});
let releaseOldResponse!: () => void;
const oldResponseGate = new Promise<void>((resolve) => {
  releaseOldResponse = resolve;
});

try {
  for (const name of proxyEnvNames) {
    process.env[name] = "http://environment-proxy.invalid:8080";
  }
  process.env.ANTIGRAVITY_PROXY = "http://127.0.0.1:7890";
  delete process.env.NOAGY_PROXY;
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
    if (!proxyAgents.includes(this)) proxyAgents.push(this);
    explicitProxyDispatches.push(`${options.method} ${options.origin}${options.path}`);
    if (pauseNextProxyDispatch) {
      pauseNextProxyDispatch = false;
      notifyOldRequestStarted();
      void oldResponseGate.then(() => mock.dispatch(options, handler));
      return true;
    }
    return mock.dispatch(options, handler);
  };
  ProxyAgent.prototype.close = function (...args: unknown[]) {
    closedProxyAgents.push(this);
    return Reflect.apply(originalProxyClose, this, args) as Promise<void>;
  };
  setGlobalDispatcher(mock);
  globalThis.fetch = (async () => {
    nativeFetchCalls += 1;
    return new Response(null, { status: 204 });
  }) as typeof fetch;

  mock
    .get("https://cloudcode-pa.googleapis.com")
    .intercept({ path: "/", method: "HEAD" })
    .reply(204);
  const proxiedResponse = await antigravityFetch("https://cloudcode-pa.googleapis.com", {
    method: "HEAD",
  });
  assert.equal(proxiedResponse.status, 204);
  assert.deepEqual(explicitProxyDispatches, ["HEAD https://cloudcode-pa.googleapis.com/"]);
  assert.equal(nativeFetchCalls, 0);
  assert.deepEqual(new Set(proxyEnvDuringRequests), new Set([expectedEnvSnapshot]));
  mock.assertNoPendingInterceptors();

  const firstAgent = proxyAgents[0];
  assert.ok(firstAgent);
  process.env.ANTIGRAVITY_PROXY = "http://127.0.0.1:7891";
  mock
    .get("https://cloudcode-pa.googleapis.com")
    .intercept({ path: "/", method: "HEAD" })
    .reply(204);
  const switchedResponse = await antigravityFetch("https://cloudcode-pa.googleapis.com", {
    method: "HEAD",
  });
  assert.equal(switchedResponse.status, 204);
  assert.equal(proxyAgents.length, 2, "changing the proxy URL must select a new agent");
  assert.ok(closedProxyAgents.includes(firstAgent), "the replaced agent must be retired");
  mock.assertNoPendingInterceptors();

  const externalResponse = await antigravityFetch(
    "https://example.com",
    { method: "HEAD" },
    { external: true },
  );
  assert.equal(externalResponse.status, 204);
  assert.equal(
    nativeFetchCalls,
    1,
    "third-party source retrieval must preserve the original native-fetch path",
  );
  assert.equal(explicitProxyDispatches.length, 2);

  process.env.ANTIGRAVITY_PROXY = "http://user:secret@invalid host";
  await assert.rejects(
    antigravityFetch("https://cloudcode-pa.googleapis.com"),
    { message: "Invalid ANTIGRAVITY_PROXY: expected an HTTP, HTTPS, or SOCKS5 proxy URL." },
  );
  assert.equal(nativeFetchCalls, 1);

  const secondAgent = proxyAgents[1];
  assert.ok(secondAgent);
  delete process.env.ANTIGRAVITY_PROXY;
  const directResponse = await antigravityFetch("https://cloudcode-pa.googleapis.com", {
    method: "HEAD",
  });
  assert.equal(directResponse.status, 204);
  assert.equal(nativeFetchCalls, 2);
  assert.ok(
    closedProxyAgents.includes(secondAgent),
    "removing ANTIGRAVITY_PROXY must retire the current agent",
  );
  assert.deepEqual(explicitProxyDispatches, [
    "HEAD https://cloudcode-pa.googleapis.com/",
    "HEAD https://cloudcode-pa.googleapis.com/",
  ]);

  process.env.ANTIGRAVITY_PROXY = "http://127.0.0.1:7892";
  pauseNextProxyDispatch = true;
  mock
    .get("https://cloudcode-pa.googleapis.com")
    .intercept({ path: "/stream", method: "GET" })
    .reply(200, "old-body", { headers: { "content-type": "text/plain" } });
  const oldRequest = antigravityFetch("https://cloudcode-pa.googleapis.com/stream");
  await oldRequestStarted;
  const oldAgent = proxyAgents[2];
  assert.ok(oldAgent);

  process.env.ANTIGRAVITY_PROXY = "http://127.0.0.1:7893";
  mock
    .get("https://cloudcode-pa.googleapis.com")
    .intercept({ path: "/", method: "HEAD" })
    .reply(204);
  const newResponse = await antigravityFetch("https://cloudcode-pa.googleapis.com", {
    method: "HEAD",
  });
  assert.equal(newResponse.status, 204);
  assert.equal(proxyAgents.length, 4);
  assert.equal(
    closedProxyAgents.includes(oldAgent),
    false,
    "an agent with an in-flight request must not close during proxy switching",
  );

  releaseOldResponse();
  const oldResponse = await oldRequest;
  assert.equal(oldResponse.status, 200);
  assert.ok(closedProxyAgents.includes(oldAgent));
  assert.equal(await oldResponse.text(), "old-body");
  mock.assertNoPendingInterceptors();

  const lastAgent = proxyAgents[3];
  assert.ok(lastAgent);
  delete process.env.ANTIGRAVITY_PROXY;
  await antigravityFetch("https://cloudcode-pa.googleapis.com", { method: "HEAD" });
  assert.ok(closedProxyAgents.includes(lastAgent));
} finally {
  globalThis.fetch = originalFetch;
  ProxyAgent.prototype.dispatch = originalProxyDispatch;
  ProxyAgent.prototype.close = originalProxyClose;
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

console.log("http proxy dispatcher bypass and explicit ProxyAgent tests passed");
