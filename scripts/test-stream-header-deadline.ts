/**
 * Guard tests for fetchWithHeaderDeadline (header phase + body-stall phase):
 * 1. A server that accepts the request but never sends headers must fail fast
 *    with a named error once the deadline elapses.
 * 2. A fast-headers fetch must succeed well inside the deadline (timer disarmed).
 * 3. Fast headers + slow body must stream to completion even when the body
 *    outlives the HEADER deadline — that deadline covers only the header phase.
 * 4. A deadline of 0 must disable the mechanism entirely.
 * 5. Headers that arrive and then a body that goes silent must abort with a
 *    named stall error once the stall deadline elapses.
 * 6. A body that keeps emitting chunks slower than the total runtime but faster
 *    than the stall deadline must complete — only silence aborts.
 */
import {
  fetchWithHeaderDeadline,
  streamHeaderTimeoutMs,
  streamStallTimeoutMs,
} from "../src/stream/stream.js";

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(`FAILED: ${message}`);
}

function hangForever(_url: string, init: RequestInit): Promise<Response> {
  return new Promise((_resolve, reject) => {
    init.signal?.addEventListener("abort", () => {
      const signal = init.signal as AbortSignal & { reason?: unknown };
      reject(signal.reason instanceof Error ? signal.reason : new Error("aborted"));
    });
  });
}

function immediateResponse(_url: string, _init: RequestInit): Promise<Response> {
  return Promise.resolve(new Response("ok"));
}
/** Headers resolve instantly; body emits one chunk then never another. */
function silentAfterFirstChunk(_url: string, init: RequestInit): Promise<Response> {
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      controller.enqueue(new TextEncoder().encode("data: first\n\n"));
      // Emulate undici: aborting the fetch signal errors the body stream with
      // the abort reason; silence otherwise lasts forever.
      await new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => {
          const signal = init.signal as AbortSignal & { reason?: unknown };
          reject(signal.reason instanceof Error ? signal.reason : new Error("aborted"));
        });
      });
      controller.close();
    },
  });
  return Promise.resolve(new Response(body));
}

/** Body emits a chunk every 20ms — slower overall, never silent past 60ms. */
function chunkyBody(_url: string, _init: RequestInit): Promise<Response> {
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      for (let i = 0; i < 5; i++) {
        await new Promise((res) => setTimeout(res, 20));
        controller.enqueue(new TextEncoder().encode(`data: chunk${i}\n\n`));
      }
      controller.close();
    },
  });
  return Promise.resolve(new Response(body));
}

async function main(): Promise<void> {
  // 1. Tarpit: never resolves, deadline fires with the named error.
  let sawTarpitError = false;
  try {
    await fetchWithHeaderDeadline("https://x", {}, undefined, 40, 0, hangForever);
    throw new Error("expected the tarpit fetch to reject");
  } catch (error) {
    sawTarpitError = error instanceof Error && /no response headers within 40ms/.test(error.message);
  }
  assert(sawTarpitError, "tarpit fetch should fail with the named header-deadline error");

  // 2. Fast headers inside the deadline succeed.
  const fast = await fetchWithHeaderDeadline("https://x", {}, undefined, 5000, 0, immediateResponse);
  assert(fast.ok, "fast fetch should succeed inside the deadline");

  // 3. Slow body outlives the HEADER deadline but headers arrived: must complete.
  const slow = await fetchWithHeaderDeadline("https://x", {}, undefined, 40, 0, chunkyBody);
  assert((await slow.text()).includes("chunk4"), "slow-body fetch must complete once headers arrived");

  // 4. Deadlines of 0 disable the mechanism.
  let sawDisablePath = false;
  try {
    await fetchWithHeaderDeadline("https://x", {}, undefined, 0, 0, (_u, i) => {
      sawDisablePath = i.signal === undefined;
      return Promise.resolve(new Response("ok"));
    });
  } catch {
    throw new Error("deadline 0 must not inject an abort signal");
  }
  assert(sawDisablePath, "deadline 0 should pass init through without a signal");

  // 5. Mid-body stall: headers fine, body silent — named stall error.
  let sawStallError = false;
  try {
    const stalled = await fetchWithHeaderDeadline("https://x", {}, undefined, 5000, 40, silentAfterFirstChunk);
    await stalled.text();
    throw new Error("expected the stalled body to reject");
  } catch (error) {
    sawStallError = error instanceof Error && /no data for 40ms/.test(error.message);
  }
  assert(sawStallError, `silent body should abort with the named stall error (got: ${sawStallError})`);

  // 6. Chunks every 20ms with 60ms stall deadline: no false positive.
  const steady = await fetchWithHeaderDeadline("https://x", {}, undefined, 5000, 60, chunkyBody);
  assert((await steady.text()).includes("chunk4"), "steady chunks must complete without a stall abort");

  // 7. The caller can still stop a response after headers and its first chunk.
  const caller = new AbortController();
  const abortable = await fetchWithHeaderDeadline(
    "https://x",
    {},
    caller.signal,
    5000,
    0,
    silentAfterFirstChunk,
  );
  const reader = abortable.body?.getReader();
  assert(reader, "abortable response should have a body");
  await reader.read();
  caller.abort(new Error("caller cancelled"));
  let sawCallerAbort = false;
  try {
    await reader.read();
  } catch (error) {
    sawCallerAbort = error instanceof Error && error.message === "caller cancelled";
  }
  assert(sawCallerAbort, "caller cancellation should stop an already-started body");

  // 8. Partially numeric timeout settings are invalid rather than silently truncated.
  process.env.ANTIGRAVITY_STREAM_HEADER_TIMEOUT_MS = "120s";
  process.env.ANTIGRAVITY_STREAM_STALL_TIMEOUT_MS = "12.5";
  assert(streamHeaderTimeoutMs() === 180_000, "partial header timeout must use the default");
  assert(streamStallTimeoutMs() === 120_000, "partial stall timeout must use the default");
  delete process.env.ANTIGRAVITY_STREAM_HEADER_TIMEOUT_MS;
  delete process.env.ANTIGRAVITY_STREAM_STALL_TIMEOUT_MS;

  console.log("test-stream-header-deadline: all assertions passed");
}

await main();
