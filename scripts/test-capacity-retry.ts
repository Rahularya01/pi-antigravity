import assert from "node:assert/strict";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
  capacityAttemptLimit,
  isCapacityFailure,
  isGenericResourceExhausted,
  streamAntigravity,
} from "../src/stream/stream.js";
import { ANTIGRAVITY_MODELS } from "../src/models/index.js";

const savedFetch = globalThis.fetch;
const savedPrewarm = process.env.ANTIGRAVITY_NO_PREWARM;
const savedBackoff = process.env.ANTIGRAVITY_CAPACITY_BACKOFF_MS;
const savedAttempts = process.env.ANTIGRAVITY_CAPACITY_ATTEMPTS;
process.env.ANTIGRAVITY_NO_PREWARM = "1";

const model = { ...ANTIGRAVITY_MODELS[0], api: "antigravity", provider: "antigravity" } as Model<Api>;
const options = {
  apiKey: JSON.stringify({ token: "test", projectId: "test-project" }),
  sessionId: "capacity-retry-test",
};
const GENERIC_429 =
  '{"error":{"code":429,"message":"Resource has been exhausted (e.g. check quota).","status":"RESOURCE_EXHAUSTED"}}';
const OK_STREAM =
  'data: {"response":{"candidates":[{"content":{"parts":[{"text":"ok"}]},"finishReason":"STOP"}]}}\n\ndata: [DONE]\n\n';

function restoreEnv(): void {
  globalThis.fetch = savedFetch;
  if (savedPrewarm === undefined) delete process.env.ANTIGRAVITY_NO_PREWARM;
  else process.env.ANTIGRAVITY_NO_PREWARM = savedPrewarm;
  if (savedBackoff === undefined) delete process.env.ANTIGRAVITY_CAPACITY_BACKOFF_MS;
  else process.env.ANTIGRAVITY_CAPACITY_BACKOFF_MS = savedBackoff;
  if (savedAttempts === undefined) delete process.env.ANTIGRAVITY_CAPACITY_ATTEMPTS;
  else process.env.ANTIGRAVITY_CAPACITY_ATTEMPTS = savedAttempts;
}

try {
  // Classification: only load-shaped refusals belong to the capacity ladder.
  assert.equal(isCapacityFailure(429, "Resource has been exhausted (e.g. check quota)."), true);
  assert.equal(
    isCapacityFailure(503, '{"error":{"code":503,"message":"No capacity available for model x"}}'),
    true,
  );
  assert.equal(isCapacityFailure(429, "Individual quota reached. Resets in 2h"), false);
  assert.equal(isCapacityFailure(429, "Quota exceeded. Resets in 2h"), false);
  assert.equal(isCapacityFailure(429, "Rate limit exceeded, too many requests"), false);
  assert.equal(isCapacityFailure(400, "Resource has been exhausted"), false);
  assert.equal(isCapacityFailure(undefined, "Resource has been exhausted"), false);

  // Ladder configuration is read per request, so tests and operators can shorten it.
  process.env.ANTIGRAVITY_CAPACITY_BACKOFF_MS = "5,5";
  assert.equal(capacityAttemptLimit(), 3);
  process.env.ANTIGRAVITY_CAPACITY_ATTEMPTS = "2";
  assert.equal(capacityAttemptLimit(), 2);
  delete process.env.ANTIGRAVITY_CAPACITY_ATTEMPTS;
  process.env.ANTIGRAVITY_CAPACITY_BACKOFF_MS = "not-a-number";
  assert.equal(capacityAttemptLimit(), 5, "invalid override falls back to the default ladder");
  process.env.ANTIGRAVITY_CAPACITY_BACKOFF_MS = "5";

  // A capacity refusal must not end the turn while attempts remain: the retry that
  // follows the first pass has to reach the endpoint again and can succeed.
  let calls = 0;
  let firstPassBody: Record<string, unknown> | undefined;
  globalThis.fetch = (async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    firstPassBody ??= body;
    calls++;
    if (calls <= 3) {
      return new Response(GENERIC_429, { status: 429, headers: { "content-type": "application/json" } });
    }
    return new Response(OK_STREAM);
  }) as typeof fetch;
  const recovered = await streamAntigravity(model, { messages: [] }, options).result();
  assert.equal(recovered.stopReason, "stop", recovered.errorMessage);
  assert.ok(calls >= 4, `capacity ladder retried the endpoint set (calls=${calls})`);
  assert.equal(firstPassBody?.requestType, "agent");

  // Exhausting the ladder keeps issue #89's terminal wording: the message must not
  // carry the tokens pi uses to retry a possibly retired model.
  process.env.ANTIGRAVITY_CAPACITY_BACKOFF_MS = "1,1";
  globalThis.fetch = (async () =>
    new Response(GENERIC_429, { status: 429 })) as typeof fetch;
  const throttled = await streamAntigravity(model, { messages: [] }, options).result();
  assert.equal(throttled.stopReason, "error");
  assert.match(throttled.errorMessage ?? "", /unavailable right now/);
  assert.match(throttled.errorMessage ?? "", /Resource has been exhausted/);
  assert.doesNotMatch(throttled.errorMessage ?? "", /\b429\b/);

  // A hard quota wall still fails immediately: its reset hint is not a capacity blip.
  let quotaCalls = 0;
  globalThis.fetch = (async () => {
    quotaCalls++;
    return new Response(
      '{"error":{"code":429,"message":"Individual quota reached. Resets in 2h.","status":"RESOURCE_EXHAUSTED"}}',
      { status: 429 },
    );
  }) as typeof fetch;
  const quotaWall = await streamAntigravity(model, { messages: [] }, options).result();
  assert.equal(quotaWall.stopReason, "error");
  assert.match(quotaWall.errorMessage ?? "", /Quota reached/);
  assert.ok(quotaCalls <= 3, `a quota wall is not retried across the ladder (calls=${quotaCalls})`);

  assert.equal(isGenericResourceExhausted("Resource has been exhausted (e.g. check quota)."), true);
} finally {
  restoreEnv();
}

console.log("capacity retry ladder, classification, and terminal message passed");
