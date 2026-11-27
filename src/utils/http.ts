import { createRequire } from "node:module";
import { dirname } from "node:path";
import type * as Undici from "undici";
import { antigravityEnv } from "./util.js";

/**
 * Node's built-in fetch keeps an idle socket for only 4 seconds unless the server
 * advertises a longer `Keep-Alive: timeout=`. The Cloud Code Assist endpoint sends no
 * such header, and interactive coding turns are almost always more than 4 seconds
 * apart, so without a dedicated pool every message pays a fresh DNS + TCP + TLS
 * handshake. A long-lived dispatcher removes that per-turn setup cost.
 *
 * The dispatcher is scoped to this provider's requests rather than installed with
 * `setGlobalDispatcher`, so it never changes HTTP behaviour for the rest of the host
 * process or for other extensions.
 *
 * Node 22+ global `fetch` cannot take an npm `undici.Agent` (handler mismatch).
 * Those runtimes already pool connections natively, so we skip the custom Agent.
 */
const KEEP_ALIVE_TIMEOUT_MS = 60_000;
const KEEP_ALIVE_MAX_TIMEOUT_MS = 5 * 60_000;
const CONNECT_TIMEOUT_MS = 10_000;
const PREWARM_TIMEOUT_MS = 5_000;

/** `dispatcher` is an undici extension to RequestInit that Node's fetch honours. */
type DispatcherInit = RequestInit & { dispatcher?: unknown };

let dispatcherPromise: Promise<unknown> | undefined;
let prewarmStarted = false;

function hasProxyConfiguration(): boolean {
  return ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"].some(
    (name) => Boolean(process.env[name]?.trim()),
  );
}

async function getDispatcher(): Promise<unknown> {
  dispatcherPromise ??= (async () => {
    // Pi configures a proxy-aware global dispatcher. Passing a private Agent here
    // would bypass it and make Antigravity requests connect directly instead.
    if (antigravityEnv("NO_KEEPALIVE") === "1" || hasProxyConfiguration()) {
      return undefined;
    }
    const nodeMajor = Number(process.versions.node?.split(".")[0]);
    if (!Number.isNaN(nodeMajor) && nodeMajor >= 22) {
      return undefined;
    }
    try {
      const { Agent } = await import("undici");
      return new Agent({
        keepAliveTimeout: KEEP_ALIVE_TIMEOUT_MS,
        keepAliveMaxTimeout: KEEP_ALIVE_MAX_TIMEOUT_MS,
        connections: 8,
        connect: { timeout: CONNECT_TIMEOUT_MS },
        // HTTP/2 is opt-in: the endpoint negotiates it, but moving SSE onto h2 is a
        // transport change we do not want to force on every user.
        allowH2: antigravityEnv("HTTP2") === "1",
      });
    } catch {
      // undici unavailable — fall back to Node's default fetch behaviour.
      return undefined;
    }
  })();
  return dispatcherPromise;
}

/**
 * Pi's Bun runtime aliases bare Undici imports to its built-in copy, which can
 * ignore npm ProxyAgent dispatchers. Load the npm package explicitly only when
 * ANTIGRAVITY_PROXY is used; the default native-fetch path stays unchanged.
 */
const nodeRequire = createRequire(import.meta.url);
type UndiciRuntime = typeof Undici;
let proxyRuntime: UndiciRuntime | undefined;

interface ProxyAgentState {
  agent: Undici.ProxyAgent;
  activeRequests: number;
  retired: boolean;
  closePromise?: Promise<void>;
}

let proxyAgentState: ProxyAgentState | undefined;
let proxyAgentUrl: string | undefined;

function getProxyRuntime(): UndiciRuntime {
  if (!proxyRuntime) {
    const undiciDir = dirname(nodeRequire.resolve("undici/package.json"));
    proxyRuntime = nodeRequire(undiciDir) as UndiciRuntime;
  }
  return proxyRuntime;
}

function closeRetiredProxyAgent(state: ProxyAgentState): void {
  if (!state.retired || state.activeRequests > 0 || state.closePromise) return;
  state.closePromise = state.agent.close().catch(() => {});
}

function retireProxyAgent(state: ProxyAgentState | undefined): void {
  if (!state) return;
  state.retired = true;
  closeRetiredProxyAgent(state);
}

function getProxyAgentState(proxyUrl: string): ProxyAgentState {
  if (proxyAgentState && proxyAgentUrl === proxyUrl) return proxyAgentState;

  const { ProxyAgent } = getProxyRuntime();
  let agent: Undici.ProxyAgent;
  try {
    const url = new URL(proxyUrl);
    if (!["http:", "https:", "socks5:"].includes(url.protocol)) {
      throw new Error("Unsupported proxy protocol");
    }
    agent = new ProxyAgent(url.href);
  } catch {
    // URL parser and dispatcher errors can contain proxy credentials.
    throw new Error("Invalid ANTIGRAVITY_PROXY: expected an HTTP, HTTPS, or SOCKS5 proxy URL.");
  }
  const nextState: ProxyAgentState = {
    agent,
    activeRequests: 0,
    retired: false,
  };
  const previousState = proxyAgentState;
  proxyAgentState = nextState;
  proxyAgentUrl = proxyUrl;
  retireProxyAgent(previousState);
  return nextState;
}

/** Return the current explicit proxy and retire the old agent when configuration is removed. */
export function configuredAntigravityProxy(): string | undefined {
  const proxyUrl = antigravityEnv("PROXY")?.trim();
  if (proxyUrl) return proxyUrl;

  const previousState = proxyAgentState;
  proxyAgentState = undefined;
  proxyAgentUrl = undefined;
  retireProxyAgent(previousState);
  return undefined;
}

/** Fetch through the explicit Antigravity proxy using one compatible npm Undici runtime. */
export async function fetchWithAntigravityProxy(
  input: string | URL,
  init: RequestInit,
  proxyUrl: string,
): Promise<Response> {
  const runtime = getProxyRuntime();
  const proxyState = getProxyAgentState(proxyUrl);
  proxyState.activeRequests += 1;
  try {
    const response = await runtime.fetch(input, {
      ...init,
      dispatcher: proxyState.agent,
    } as Parameters<UndiciRuntime["fetch"]>[1]);
    return response as unknown as Response;
  } finally {
    // Fetch resolves after the final redirect's response headers arrive. Graceful
    // agent close still waits for the response body after this dispatch is released.
    proxyState.activeRequests -= 1;
    closeRetiredProxyAgent(proxyState);
  }
}

/** fetch() bound to this provider's keep-alive connection pool when available. */
export async function antigravityFetch(
  input: string | URL,
  init: RequestInit = {},
  options: { external?: boolean } = {},
): Promise<Response> {
  // Source URLs are validated against local DNS before fetching. A provider proxy
  // can resolve names in a different network, so keep source requests on their existing path.
  const explicitProxy = options.external ? undefined : configuredAntigravityProxy();
  if (explicitProxy) {
    return fetchWithAntigravityProxy(input, init, explicitProxy);
  }

  const dispatcher = await getDispatcher();
  if (!dispatcher) return fetch(input, init);
  return fetch(input, { ...init, dispatcher } as DispatcherInit);
}

/**
 * Open the TLS connection on the first Antigravity request so that turn does not
 * pay the handshake. Not called at extension load: an unauthenticated HEAD to the
 * endpoint can stall Node's event loop until connect timeout and freeze Pi startup.
 * Best-effort: failures are ignored. Subsequent calls are no-ops.
 */
export function prewarmConnection(url: string): void {
  if (antigravityEnv("NO_PREWARM") === "1") return;
  if (prewarmStarted) return;
  prewarmStarted = true;
  void (async () => {
    try {
      const res = await antigravityFetch(url, {
        method: "HEAD",
        signal: AbortSignal.timeout(PREWARM_TIMEOUT_MS),
      });
      // Release the socket back to the pool even though HEAD carries no body.
      await res.arrayBuffer();
    } catch {
      // Warm-up only; the real request will establish the connection instead.
    }
  })();
}
