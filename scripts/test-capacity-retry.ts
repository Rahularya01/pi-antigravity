import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
  capacityAttemptLimit,
  clearCapacityRouteCache,
  isCapacityFailure,
  isGenericResourceExhausted,
  streamAntigravity,
} from "../src/stream/stream.js";
import { ANTIGRAVITY_MODELS } from "../src/models/index.js";

const isolatedHome = mkdtempSync(join(tmpdir(), "antigravity-capacity-test-"));
const savedFetch = globalThis.fetch;
const savedEnv = {
  HOME: process.env.HOME,
  USERPROFILE: process.env.USERPROFILE,
  ANTIGRAVITY_NO_PREWARM: process.env.ANTIGRAVITY_NO_PREWARM,
  ANTIGRAVITY_CAPACITY_BACKOFF_MS: process.env.ANTIGRAVITY_CAPACITY_BACKOFF_MS,
  NOAGY_CAPACITY_BACKOFF_MS: process.env.NOAGY_CAPACITY_BACKOFF_MS,
  ANTIGRAVITY_CAPACITY_ATTEMPTS: process.env.ANTIGRAVITY_CAPACITY_ATTEMPTS,
  NOAGY_CAPACITY_ATTEMPTS: process.env.NOAGY_CAPACITY_ATTEMPTS,
  ANTIGRAVITY_BASE_URL: process.env.ANTIGRAVITY_BASE_URL,
  NOAGY_BASE_URL: process.env.NOAGY_BASE_URL,
  ANTIGRAVITY_RUNTIME_MODEL: process.env.ANTIGRAVITY_RUNTIME_MODEL,
  NOAGY_RUNTIME_MODEL: process.env.NOAGY_RUNTIME_MODEL,
};
process.env.HOME = isolatedHome;
process.env.USERPROFILE = isolatedHome;
process.env.ANTIGRAVITY_NO_PREWARM = "1";
delete process.env.NOAGY_CAPACITY_BACKOFF_MS;
delete process.env.NOAGY_CAPACITY_ATTEMPTS;
delete process.env.ANTIGRAVITY_BASE_URL;
delete process.env.NOAGY_BASE_URL;
delete process.env.ANTIGRAVITY_RUNTIME_MODEL;
delete process.env.NOAGY_RUNTIME_MODEL;

const model = {
  ...ANTIGRAVITY_MODELS.find((m) => m.id === "gemini-3.8-flash")!,
  api: "antigravity",
  provider: "antigravity",
} as Model<Api>;
const options = {
  apiKey: JSON.stringify({ token: "test", projectId: "test-project" }),
  sessionId: "capacity-retry-test",
  reasoning: "high" as const,
};
const GENERIC_429 =
  '{"error":{"code":429,"message":"Resource has been exhausted (e.g. check quota).","status":"RESOURCE_EXHAUSTED"}}';
const OK_STREAM =
  'data: {"response":{"candidates":[{"content":{"parts":[{"text":"ok"}]},"finishReason":"STOP"}]}}\n\ndata: [DONE]\n\n';
const EMPTY_STREAM =
  'data: {"response":{"candidates":[{"content":{"parts":[]},"finishReason":"STOP"}]}}\n\ndata: [DONE]\n\n';

function restoreEnv(): void {
  globalThis.fetch = savedFetch;
  clearCapacityRouteCache();
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(isolatedHome, { recursive: true, force: true });
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
  delete process.env.ANTIGRAVITY_CAPACITY_ATTEMPTS;
  assert.equal(capacityAttemptLimit(), 3);
  process.env.ANTIGRAVITY_CAPACITY_ATTEMPTS = "2";
  assert.equal(capacityAttemptLimit(), 2);
  delete process.env.ANTIGRAVITY_CAPACITY_ATTEMPTS;
  process.env.ANTIGRAVITY_CAPACITY_BACKOFF_MS = "not-a-number";
  assert.equal(capacityAttemptLimit(), 5, "invalid override falls back to the default ladder");
  process.env.ANTIGRAVITY_CAPACITY_BACKOFF_MS = "5";

  // True outer retry + sibling tiers retried on pass 2:
  // Pass 1 fails every endpoint (2) x every tier + compatibility fallback (4) -> 8 calls.
  // Pass 2 fails high (2 endpoints) and then succeeds on medium, proving both that
  // the outer retry ladder runs AND that sibling tiers are walked again on pass 2.
  clearCapacityRouteCache();
  let calls = 0;
  const modelsSeen: string[] = [];
  let firstPassBody: Record<string, unknown> | undefined;
  globalThis.fetch = (async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    firstPassBody ??= body;
    calls++;
    const reqModel = String(body.model ?? "");
    modelsSeen.push(reqModel);
    // Fail all 8 calls of pass 1 plus the 2 high-tier calls of pass 2; succeed on pass-2 medium.
    if (calls <= 10 || reqModel !== "gemini-3.8-flash-medium") {
      return new Response(GENERIC_429, {
        status: 429,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(OK_STREAM);
  }) as typeof fetch;
  const recovered = await streamAntigravity(model, { messages: [] }, options).result();
  assert.equal(recovered.stopReason, "stop", recovered.errorMessage);
  assert.ok(calls >= 11, `expected outer retry into pass-2 sibling tier (calls=${calls})`);
  assert.ok(
    modelsSeen.includes("gemini-3.7-flash-high"),
    `expected queued compatibility fallback during pass 1, saw ${JSON.stringify(modelsSeen)}`,
  );
  assert.equal(modelsSeen.at(-1), "gemini-3.8-flash-medium");
  assert.equal(firstPassBody?.requestType, "agent");

  // Caller abort during a long capacity backoff cancels promptly instead of waiting out the timer.
  clearCapacityRouteCache();
  process.env.ANTIGRAVITY_CAPACITY_BACKOFF_MS = "60000";
  const controller = new AbortController();
  let abortTestCalls = 0;
  globalThis.fetch = (async () => {
    abortTestCalls++;
    if (abortTestCalls === 8) {
      // Trigger abort shortly after pass 1 finishes and enters the 60s sleep.
      setTimeout(() => controller.abort(new Error("user cancelled")), 25);
    }
    return new Response(GENERIC_429, { status: 429 });
  }) as typeof fetch;
  const abortStart = Date.now();
  const aborted = await streamAntigravity(
    model,
    { messages: [] },
    { ...options, signal: controller.signal },
  ).result();
  const abortElapsed = Date.now() - abortStart;
  assert.equal(aborted.stopReason, "aborted");
  assert.ok(abortElapsed < 5_000, `abort during backoff should cancel promptly (took ${abortElapsed}ms)`);

  // Empty-response recovery stays independent of ANTIGRAVITY_CAPACITY_ATTEMPTS=1.
  clearCapacityRouteCache();
  process.env.ANTIGRAVITY_CAPACITY_BACKOFF_MS = "1";
  process.env.ANTIGRAVITY_CAPACITY_ATTEMPTS = "1";
  let emptyCalls = 0;
  globalThis.fetch = (async () => {
    emptyCalls++;
    return new Response(emptyCalls <= 2 ? EMPTY_STREAM : OK_STREAM);
  }) as typeof fetch;
  const emptyRecovered = await streamAntigravity(model, { messages: [] }, options).result();
  assert.equal(emptyRecovered.stopReason, "stop", emptyRecovered.errorMessage);
  assert.equal(emptyCalls, 3, "empty responses still retry up to 3 attempts when capacity attempts=1");
  delete process.env.ANTIGRAVITY_CAPACITY_ATTEMPTS;

  // Exhausting the ladder keeps issue #89's terminal wording: the message must not
  // carry the tokens pi uses to retry a possibly retired model.
  clearCapacityRouteCache();
  process.env.ANTIGRAVITY_CAPACITY_BACKOFF_MS = "1,1";
  globalThis.fetch = (async () =>
    new Response(GENERIC_429, { status: 429 })) as typeof fetch;
  const throttled = await streamAntigravity(model, { messages: [] }, options).result();
  assert.equal(throttled.stopReason, "error");
  assert.match(throttled.errorMessage ?? "", /unavailable right now/);
  assert.match(throttled.errorMessage ?? "", /Resource has been exhausted/);
  assert.doesNotMatch(throttled.errorMessage ?? "", /\b429\b/);

  // A hard quota wall still fails immediately: its reset hint is not a capacity blip.
  clearCapacityRouteCache();
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
  assert.ok(quotaCalls <= 2, `a quota wall is not retried across the ladder (calls=${quotaCalls})`);

  assert.equal(isGenericResourceExhausted("Resource has been exhausted (e.g. check quota)."), true);
} finally {
  restoreEnv();
}

console.log("capacity retry ladder, abort handling, empty recovery, and terminal message passed");
