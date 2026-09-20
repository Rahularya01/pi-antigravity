/**
 * Transcript-context compatibility tests (pi >= 0.86).
 *
 * pi 0.86 normalizes provider inputs: the system prompt and tool declarations are
 * carried by system messages inside `context.messages` (read via
 * `getCurrentSystemPrompt()` / `getCurrentTools()`) instead of the flat
 * `context.systemPrompt` / `context.tools` fields, which stay undefined.
 *
 * Without transcript awareness, requests go out with no functionDeclarations and
 * a generic fallback system prompt; the agentic-tuned Gemini runtime models then
 * emit unmatched tool calls and the backend fails the turn with
 * MALFORMED_FUNCTION_CALL.
 *
 * These tests cover both context shapes. The transcript-shape group is skipped
 * when the installed pi-ai predates 0.86 (helpers unavailable at runtime).
 */
import * as piAi from "@earendil-works/pi-ai";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import type { Tool } from "@earendil-works/pi-ai";
import { buildRequest, convertMessages } from "../src/stream/stream.ts";

type StreamContext = {
  systemPrompt?: string;
  tools?: Tool[];
  messages: piAi.Message[];
};

const helpers = piAi as unknown as {
  getCurrentSystemPrompt?: (messages: piAi.Message[]) => string;
  getCurrentTools?: (messages: piAi.Message[]) => Tool[];
};
const hasTranscriptHelpers = typeof helpers.getCurrentSystemPrompt === "function";

let failures = 0;
function assert(condition: boolean, message: string): void {
  if (condition) {
    console.log(`  ok  ${message}`);
  } else {
    failures += 1;
    console.error(`FAIL  ${message}`);
  }
}

const model = {
  id: "gemini-3.1-pro",
  cost: { input: 0.1, output: 0.4, cacheRead: 0.025, cacheWrite: 0.1 },
} as Model<Api>;

const options = { reasoning: "low", maxTokens: 4096 } as Parameters<typeof buildRequest>[3];

const tools: Tool[] = [
  {
    name: "read",
    description: "Read a file",
    parameters: {
      type: "object",
      properties: { path: { type: "string", description: "file path" } },
      required: ["path"],
    },
  },
  {
    name: "bash",
    description: "Run a shell command",
    parameters: {
      type: "object",
      properties: { cmd: { type: "string" } },
      required: ["cmd"],
    },
  },
];

function systemText(request: ReturnType<typeof buildRequest>): string {
  return (request.request.systemInstruction?.parts ?? [])
    .map((part) => part.text)
    .join("\n");
}

function declarations(request: ReturnType<typeof buildRequest>): string[] {
  return (request.request.tools?.[0]?.functionDeclarations ?? []).map((d) => d.name);
}

function transcriptContext(): StreamContext {
  return {
    messages: [
      {
        role: "system",
        content: "PI-SYSTEM-PROMPT-MARKER-v86",
        toolsAdded: tools,
        timestamp: 0,
      },
      {
        role: "user",
        content: [{ type: "text", text: "list the files please", timestamp: 1 }],
        timestamp: 1,
      },
    ],
  } as unknown as StreamContext;
}

function legacyContext(): StreamContext {
  return {
    systemPrompt: "LEGACY-SYSTEM-PROMPT-MARKER",
    tools,
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: "list the files please", timestamp: 1 }],
        timestamp: 1,
      },
    ],
  };
}

async function main(): Promise<void> {
  // --- Group 1: transcript shape (pi >= 0.86) ---
  if (hasTranscriptHelpers) {
    console.log("transcript context (pi >= 0.86):");
    const request = buildRequest(
      model,
      transcriptContext() as Parameters<typeof buildRequest>[1],
      "test-project",
      options,
      "gemini-3.1-pro-low",
    );
    assert(
      systemText(request).includes("PI-SYSTEM-PROMPT-MARKER-v86"),
      "system prompt read from transcript system message",
    );
    assert(
      !systemText(request).includes("Google DeepMind"),
      "generic fallback system prompt not used",
    );
    assert(
      JSON.stringify(declarations(request)) === JSON.stringify(["read", "bash"]),
      "functionDeclarations read from transcript toolsAdded",
    );
    assert(
      !(request.request.contents ?? []).some((turn) => turn.role === ("system" as never)),
      "system messages not leaked into contents",
    );
  } else {
    console.log(
      "transcript context (pi >= 0.86): SKIPPED (installed pi-ai lacks transcript helpers)",
    );
  }

  // --- Group 2: legacy flat Context shape (pi <= 0.85 regression) ---
  console.log("legacy flat context (pi <= 0.85):");
  const legacyRequest = buildRequest(
    model,
    legacyContext() as Parameters<typeof buildRequest>[1],
    "test-project",
    options,
    "gemini-3.1-pro-low",
  );
  assert(
    systemText(legacyRequest).includes("LEGACY-SYSTEM-PROMPT-MARKER"),
    "flat context.systemPrompt fallback works",
  );
  assert(
    JSON.stringify(declarations(legacyRequest)) === JSON.stringify(["read", "bash"]),
    "flat context.tools fallback works",
  );

  // --- Group 3: convertMessages drops system turns ---
  console.log("convertMessages:");
  const context = hasTranscriptHelpers ? transcriptContext() : legacyContext();
  const contents = convertMessages(model, context as Parameters<typeof convertMessages>[1], "gemini-3.1-pro-low");
  assert(
    !contents.some((turn) => turn.role === ("system" as never)),
    "no system role in Gemini contents",
  );
  assert(contents.some((turn) => turn.role === "user"), "user turn present");

  // --- Group 4: signed tool-call history round-trips ---
  console.log("tool history round-trip:");
  const history: StreamContext = {
    messages: [
      ...(hasTranscriptHelpers
        ? [{ role: "system", content: "P", toolsAdded: tools, timestamp: 0 } as piAi.Message]
        : []),
      {
        role: "user",
        content: [{ type: "text", text: "read x", timestamp: 1 }],
        timestamp: 1,
      },
      {
        role: "assistant",
        provider: "antigravity",
        model: "gemini-3.1-pro",
        api: "antigravity" as AssistantMessage["api"],
        stopReason: "toolUse",
        timestamp: 2,
        content: [
          {
            type: "toolCall",
            id: "call-1",
            name: "read",
            arguments: { path: "x.ts" },
            thoughtSignature: "abcd",
          },
        ],
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      },
      {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "read",
        isError: false,
        timestamp: 3,
        content: [{ type: "text", text: "file body" }],
      },
    ] as piAi.Message[],
  };
  const historyContents = convertMessages(
    model,
    history as Parameters<typeof convertMessages>[1],
    "gemini-3.1-pro-low",
  );
  const flat = JSON.stringify(historyContents);
  assert(flat.includes('"functionCall"'), "functionCall replayed from history");
  assert(flat.includes('"functionResponse"'), "functionResponse replayed from history");
  assert(!flat.includes("toolsAdded"), "system payloads not leaked into contents");

  if (failures > 0) {
    process.exit(1);
  }
  console.log(`transcript context: all checks passed`);
}

void main();
