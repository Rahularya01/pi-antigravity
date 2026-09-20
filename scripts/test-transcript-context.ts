/**
 * Transcript-context compatibility tests (pi >= 0.86).
 *
 * pi 0.86 normalizes provider inputs: the system prompt and tool declarations are
 * carried by system messages inside `context.messages` instead of the flat
 * `context.systemPrompt` / `context.tools` fields.
 */
import type { Api, AssistantMessage, Context, Model, Tool } from "@earendil-works/pi-ai";
import { buildRequest, convertMessages } from "../src/stream/stream.ts";

function fail(message: string): never {
  throw new Error(message);
}

const assert = {
  equal(actual: unknown, expected: unknown, message?: string) {
    if (actual !== expected) fail(message ?? `expected ${String(expected)}, got ${String(actual)}`);
  },
  deepEqual(actual: unknown, expected: unknown, message?: string) {
    const actStr = JSON.stringify(actual);
    const expStr = JSON.stringify(expected);
    if (actStr !== expStr) fail(message ?? `expected ${expStr}, got ${actStr}`);
  },
  ok(value: unknown, message?: string) {
    if (!value) fail(message ?? "expected a truthy value");
  },
};

const testModel = {
  api: "antigravity-api",
  provider: "antigravity",
  baseUrl: "https://cloudcode-pa.googleapis.com",
  id: "gemini-3.8-flash",
  name: "Gemini 3.8 Flash",
  reasoning: true,
  input: ["text", "image"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1048576,
  maxTokens: 65536,
} as Model<Api>;

const bashTool: Tool = {
  name: "bash",
  description: "Execute bash command",
  parameters: {
    type: "object",
    properties: {
      command: { type: "string", description: "Shell command" },
    },
    required: ["command"],
  },
};

const editTool: Tool = {
  name: "edit",
  description: "Edit file",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string" },
      content: { type: "string" },
    },
    required: ["path", "content"],
  },
};

function declarations(request: ReturnType<typeof buildRequest>): string[] {
  return (request.request.tools?.[0]?.functionDeclarations ?? []).map((item) => item.name);
}

function systemText(request: ReturnType<typeof buildRequest>): string {
  return (request.request.systemInstruction?.parts ?? []).map((part) => part.text).join("\n");
}

const transcriptContext = {
  messages: [
    {
      role: "system" as const,
      content: "You are an expert developer.",
      toolsAdded: [bashTool, editTool],
      timestamp: Date.now(),
    },
    {
      role: "user" as const,
      content: "Please edit index.ts",
      timestamp: Date.now(),
    },
  ],
} as unknown as Context;

const transcriptReq = buildRequest(testModel, transcriptContext, "test-project", {}, "gemini-3.8-flash");
assert.ok(transcriptReq.request.tools, "request.tools must not be undefined");
assert.deepEqual(declarations(transcriptReq), ["bash", "edit"]);
assert.equal(systemText(transcriptReq), "You are an expert developer.");
assert.ok(
  !systemText(transcriptReq).includes("Google DeepMind"),
  "generic fallback system prompt not used",
);
assert.ok(
  !(transcriptReq.request.contents ?? []).some((turn) => turn.role === ("system" as never)),
  "system messages not leaked into contents",
);

const legacyContext: Context = {
  systemPrompt: "You are a legacy assistant.",
  tools: [bashTool],
  messages: [
    {
      role: "user",
      content: "Run ls",
      timestamp: Date.now(),
    },
  ],
};
const legacyReq = buildRequest(testModel, legacyContext, "test-project", {}, "gemini-3.8-flash");
assert.deepEqual(declarations(legacyReq), ["bash"]);
assert.equal(systemText(legacyReq), "You are a legacy assistant.");

const sectionContext = {
  messages: [
    {
      role: "system",
      sections: {
        intro: "You are a helpful coding assistant.",
        rules: "Follow all coding conventions.",
      },
      toolsAdded: [bashTool],
    },
    { role: "user", content: "hello" },
  ],
} as unknown as Context;
const sectionReq = buildRequest(testModel, sectionContext, "test-project", {}, "gemini-3.8-flash");
assert.ok(systemText(sectionReq).includes("You are a helpful coding assistant."));
assert.ok(systemText(sectionReq).includes("Follow all coding conventions."));
assert.deepEqual(declarations(sectionReq), ["bash"]);

const multiTurnContext = {
  messages: [
    {
      role: "system" as const,
      content: "Initial system prompt",
      toolsAdded: [bashTool],
      timestamp: 1000,
    },
    {
      role: "user" as const,
      content: "hello",
      timestamp: 1001,
    },
    {
      role: "assistant" as const,
      content: [{ type: "text", text: "hi" }],
      stopReason: "stop" as const,
      timestamp: 1002,
    },
    {
      role: "system" as const,
      content: "Updated system prompt",
      toolsRemoved: [{ name: "bash" }],
      toolsAdded: [editTool],
      timestamp: 1003,
    },
    {
      role: "user" as const,
      content: "now edit file",
      timestamp: 1004,
    },
  ],
} as unknown as Context;
const dynamicReq = buildRequest(testModel, multiTurnContext, "test-project", {}, "gemini-3.8-flash");
assert.deepEqual(declarations(dynamicReq), ["edit"]);
assert.ok(systemText(dynamicReq).includes("Updated system prompt"));

const noToolsContext = {
  messages: [
    {
      role: "system" as const,
      content: "Just talk.",
      timestamp: Date.now(),
    },
    {
      role: "user" as const,
      content: "Tell me a joke.",
      timestamp: Date.now(),
    },
  ],
} as unknown as Context;
const noToolsReq = buildRequest(testModel, noToolsContext, "test-project", {}, "gemini-3.8-flash");
assert.equal(noToolsReq.request.tools, undefined, "request.tools must be undefined when no tools declared");

const contents = convertMessages(testModel, transcriptContext, "gemini-3.8-flash");
assert.ok(!contents.some((turn) => turn.role === ("system" as never)), "no system role in Gemini contents");
assert.ok(contents.some((turn) => turn.role === "user"), "user turn present");

const history = {
  messages: [
    {
      role: "system",
      content: "P",
      toolsAdded: [bashTool],
      timestamp: 0,
    },
    {
      role: "user",
      content: [{ type: "text", text: "read x", timestamp: 1 }],
      timestamp: 1,
    },
    {
      role: "assistant",
      provider: "antigravity",
      model: "gemini-3.8-flash",
      api: "antigravity-api" as AssistantMessage["api"],
      stopReason: "toolUse",
      timestamp: 2,
      content: [
        {
          type: "toolCall",
          id: "call-1",
          name: "bash",
          arguments: { command: "ls" },
          thoughtSignature: "abcdabcd",
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
      toolName: "bash",
      isError: false,
      timestamp: 3,
      content: [{ type: "text", text: "file body" }],
    },
  ],
} as unknown as Context;
const historyContents = convertMessages(testModel, history, "gemini-3.8-flash");
const flat = JSON.stringify(historyContents);
assert.ok(flat.includes('"functionCall"') || flat.includes("Observation"), "tool history replayed");
assert.ok(!flat.includes("toolsAdded"), "system payloads not leaked into contents");

console.log("scripts/test-transcript-context.ts: all TranscriptContext tests passed");
