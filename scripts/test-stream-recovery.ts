import assert from "node:assert/strict";
import type { Api, Model } from "@earendil-works/pi-ai";
import { streamAntigravity } from "../src/stream/stream.js";
import { ANTIGRAVITY_MODELS } from "../src/models/index.js";

const savedFetch = globalThis.fetch;
const savedPrewarm = process.env.ANTIGRAVITY_NO_PREWARM;
process.env.ANTIGRAVITY_NO_PREWARM = "1";
const bodies: any[] = [];
const model = { ...ANTIGRAVITY_MODELS[0], api: "antigravity", provider: "antigravity" } as Model<Api>;
const options = { apiKey: JSON.stringify({ token: "test", projectId: "test-project" }), sessionId: "recovery-test" };
try {
  let calls = 0;
  globalThis.fetch = (async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)));
    if (++calls === 1) throw new Error("fetch failed");
    return new Response('data: {"response":{"candidates":[{"content":{"parts":[{"text":"ok"}]},"finishReason":"STOP"}]}}\n\ndata: [DONE]\n\n');
  }) as typeof fetch;
  const first = await streamAntigravity(model, { messages: [] }, options).result();
  assert.equal(first.stopReason, "stop", first.errorMessage);
  assert.equal(calls, 2, "transport errors try the next endpoint");
  assert.notEqual(bodies[0].request.sessionId, bodies[1].request.sessionId);
  const second = await streamAntigravity(model, { messages: [] }, options).result();
  assert.equal(second.stopReason, "stop", second.errorMessage);
  assert.notEqual(bodies[1].request.sessionId, bodies[2].request.sessionId);

  globalThis.fetch = (async () => { throw new Error("transport timed out"); }) as typeof fetch;
  const failed = await streamAntigravity(model, { messages: [] }, options).result();
  assert.match(failed.errorMessage ?? "", /timed out/);
  const controller = new AbortController();
  controller.abort();
  let abortCalls = 0;
  globalThis.fetch = (async () => { abortCalls++; throw new Error("cancelled"); }) as typeof fetch;
  const aborted = await streamAntigravity(model, { messages: [] }, { ...options, signal: controller.signal }).result();
  assert.equal(aborted.stopReason, "aborted");
  assert.ok(abortCalls <= 1, "caller cancellation never falls through endpoints");
} finally {
  globalThis.fetch = savedFetch;
  if (savedPrewarm === undefined) delete process.env.ANTIGRAVITY_NO_PREWARM;
  else process.env.ANTIGRAVITY_NO_PREWARM = savedPrewarm;
}
console.log("stream recovery: endpoint fallback, fresh identity, transport errors and cancellation passed");
