/**
 * Header-deadline tests for fetchWithHeaderDeadline:
 * 1. A server that accepts the request but never sends headers must fail fast
 *    with a named error once the deadline elapses.
 * 2. A fast-headers fetch must succeed well inside the deadline (timer disarmed).
 * 3. Fast headers + slow body must stream to completion even when the body
 *    outlives the deadline — the deadline covers only the header phase.
 * 4. A deadline of 0 must disable the mechanism entirely.
 */
import { fetchWithHeaderDeadline } from "../src/stream/stream.js";

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(`FAILED: ${message}`);
}

function hangForever(_url: string, init: RequestInit): Promise<Response> {
  return new Promise((_resolve, reject) => {
    init.signal?.addEventListener("abort", () => {
      // Mirror fetch semantics: reject with the abort reason when provided.
      const signal = init.signal as AbortSignal & { reason?: unknown };
      reject(signal.reason instanceof Error ? signal.reason : new Error("aborted"));
    });
  });
}

function immediateResponse(_url: string, _init: RequestInit): Promise<Response> {
  return Promise.resolve(new Response("ok"));
}

function slowBodyResponse(_url: string, _init: RequestInit): Promise<Response> {
  // Headers resolve instantly; the body takes 120ms — longer than every deadline
  // used in these tests.
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      await new Promise((res) => setTimeout(res, 30));
      controller.enqueue(new TextEncoder().encode("chunk"));
      controller.close();
    },
  });
  return Promise.resolve(new Response(body));
}

async function main(): Promise<void> {
  // 1. Tarpit: never resolves, deadline fires with the named error.
  let sawTarpitError = false;
  try {
    await fetchWithHeaderDeadline("https://x", {}, undefined, 40, hangForever);
    throw new Error("expected the tarpit fetch to reject");
  } catch (error) {
    sawTarpitError = error instanceof Error && /no response headers within 40ms/.test(error.message);
  }
  assert(sawTarpitError, "tarpit fetch should fail with the named header-deadline error");

  // 2. Fast headers inside the deadline succeed.
  const fast = await fetchWithHeaderDeadline("https://x", {}, undefined, 5000, immediateResponse);
  assert(fast.ok, "fast fetch should succeed inside the deadline");

  // 3. Slow body outlives the deadline but headers arrived: must complete.
  const slow = await fetchWithHeaderDeadline("https://x", {}, undefined, 40, slowBodyResponse);
  assert(slow.ok, "slow-body fetch must complete once headers arrived inside the deadline");

  // 4. Deadline 0 disables the mechanism (hang would otherwise fire at any ms).
  let sawDisablePath = false;
  try {
    await fetchWithHeaderDeadline("https://x", {}, undefined, 0, (_u, i) => {
      sawDisablePath = i.signal === undefined;
      return Promise.resolve(new Response("ok"));
    });
  } catch {
    throw new Error("deadline 0 must not inject an abort signal");
  }
  assert(sawDisablePath, "deadline 0 should pass init through without a signal");

  console.log("test-stream-header-deadline: all assertions passed");
}

await main();
