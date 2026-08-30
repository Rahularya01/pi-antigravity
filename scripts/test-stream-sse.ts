/**
 * SSE parser tests: the read buffer is compacted once per network chunk rather than
 * per line, so the parser must stay correct for every possible chunk boundary,
 * including boundaries that split a single `data:` line.
 */
import { createAssistantMessageEventStream, type Api, type Model } from "@earendil-works/pi-ai";
import { streamResponse } from "../src/stream/stream.js";
import type { AssistantMessage } from "@earendil-works/pi-ai";

function sse(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n`;
}

const BODY =
  sse({ response: { candidates: [{ content: { parts: [{ text: "Hello" }] } }] } }) +
  sse({
    response: { candidates: [{ content: { parts: [{ text: " world", thought: false }] } }] },
  }) +
  sse({ response: { candidates: [{ content: { parts: [{ thought: true, text: "hmm" }] } }] } }) +
  sse({
    response: {
      candidates: [
        {
          content: { parts: [{ functionCall: { name: "read", args: { path: "a.ts" } } }] },
          finishReason: "STOP",
        },
      ],
      usageMetadata: {
        promptTokenCount: 100,
        cachedContentTokenCount: 40,
        candidatesTokenCount: 7,
        thoughtsTokenCount: 3,
        totalTokenCount: 110,
      },
    },
  }) +
  "data: [DONE]\n";

function makeOutput(): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: "antigravity" as unknown as AssistantMessage["api"],
    provider: "antigravity",
    model: "gemini-3.7-flash",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 0,
  } as AssistantMessage;
}

function responseFromChunks(chunks: string[]): Response {
  const encoder = new TextEncoder();
  let i = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i >= chunks.length) {
        controller.close();
        return;
      }
      controller.enqueue(encoder.encode(chunks[i]!));
      i += 1;
    },
  });
  return new Response(body);
}

function splitEvery(text: string, size: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

async function run(chunks: string[], model?: Model<Api>) {
  const stream = createAssistantMessageEventStream();
  const output = makeOutput();
  const hasContent = await streamResponse(responseFromChunks(chunks), stream, output, model);
  stream.end();
  const events: string[] = [];
  for await (const event of stream) events.push(event.type);
  return { hasContent, output, events };
}

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(`FAILED: ${message}`);
}

async function main() {
  // Every chunk size from 1 byte (splits every line) up to the whole body at once.
  const sizes = [1, 2, 3, 5, 7, 13, 64, 257, BODY.length];
  let baseline: string | undefined;

  for (const size of sizes) {
    const { hasContent, output, events } = await run(splitEvery(BODY, size));
    assert(hasContent, `chunk size ${size}: expected content`);

    const text = output.content
      .filter((b) => b.type === "text")
      .map((b) => (b as { text: string }).text)
      .join("");
    const thinking = output.content
      .filter((b) => b.type === "thinking")
      .map((b) => (b as { thinking: string }).thinking)
      .join("");
    const toolCalls = output.content.filter((b) => b.type === "toolCall");

    assert(text === "Hello world", `chunk size ${size}: text was ${JSON.stringify(text)}`);
    assert(thinking === "hmm", `chunk size ${size}: thinking was ${JSON.stringify(thinking)}`);
    assert(toolCalls.length === 1, `chunk size ${size}: expected 1 tool call`);
    assert(
      (toolCalls[0] as { name: string }).name === "read",
      `chunk size ${size}: tool call name`,
    );
    assert(output.stopReason === "toolUse", `chunk size ${size}: stopReason ${output.stopReason}`);
    assert(output.rawStopReason === "STOP", `chunk size ${size}: rawStopReason ${output.rawStopReason}`);
    assert(output.usage.input === 60, `chunk size ${size}: input ${output.usage.input}`);
    assert(output.usage.cacheRead === 40, `chunk size ${size}: cacheRead`);
    assert(output.usage.output === 10, `chunk size ${size}: output ${output.usage.output}`);
    assert(output.usage.reasoning === 3, `chunk size ${size}: reasoning ${output.usage.reasoning}`);
    assert(output.usage.totalTokens === 110, `chunk size ${size}: totalTokens`);

    // Chunk boundaries must not change the emitted event sequence.
    const signature = events.join(",");
    baseline ??= signature;
    assert(
      signature === baseline,
      `chunk size ${size}: event sequence drifted\n  ${signature}\n  ${baseline}`,
    );
  }

  // A body with no trailing newline on the last line still parses the earlier lines.
  const truncated = BODY.slice(0, BODY.lastIndexOf("data: [DONE]"));
  const { hasContent } = await run([truncated.slice(0, 40), truncated.slice(40)]);
  assert(hasContent, "truncated body: expected content");

  // Verify cost calculation when model is provided
  const dummyModel = {
    id: "gemini-3.7-flash",
    cost: { input: 0.1, output: 0.4, cacheRead: 0.025, cacheWrite: 0.1 },
  } as Model<Api>;
  const costRun = await run([BODY], dummyModel);
  // input: 60 -> (0.1/1e6)*60 = 0.000006, cacheRead: 40 -> (0.025/1e6)*40 = 0.000001, output: 10 -> (0.4/1e6)*10 = 0.000004
  // total: 0.000011
  assert(Math.abs(costRun.output.usage.cost.total - 0.000011) < 1e-9, "cost calculation matches expected total");
  assert(Math.abs(costRun.output.usage.cost.input - 0.000006) < 1e-9, "cost calculation matches expected input");

  // Verify graceful fallback when model or model.cost is omitted
  const noCostModel = { id: "unknown-custom" } as Model<Api>;
  const noCostRun = await run([BODY], noCostModel);
  assert(noCostRun.output.usage.cost.total === 0, "omitted cost defaults total to 0");
  assert(noCostRun.output.usage.cost.input === 0, "omitted cost defaults input to 0");

  console.log(`stream SSE: ${sizes.length} chunk-boundary cases passed`);
}

void main();
