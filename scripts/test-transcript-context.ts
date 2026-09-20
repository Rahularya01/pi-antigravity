import type { Api, Context, Model, Tool } from "@earendil-works/pi-ai";
import { buildRequest } from "../src/stream/index.js";

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

const testModel: Model<Api> = {
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
};

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

// 1. Issue #52: Extract tools and system prompt from normalized TranscriptContext (Pi 0.86.0)
const transcriptContext: Context = {
  messages: [
    {
      role: "system" as const,
      content: "You are an expert developer.",
      toolsAdded: [bashTool, editTool],
      timestamp: Date.now(),
    } as any,
    {
      role: "user" as const,
      content: "Please edit index.ts",
      timestamp: Date.now(),
    },
  ],
};

const request = buildRequest(
  testModel,
  transcriptContext,
  "test-project",
  {},
  "gemini-3.8-flash",
);

assert.ok(request.request.tools, "request.tools must not be undefined");
assert.equal(request.request.tools?.length, 1);
const decls = request.request.tools?.[0]?.functionDeclarations;
assert.ok(decls, "functionDeclarations must exist");
assert.equal(decls?.length, 2);
assert.equal(decls?.[0]?.name, "bash");
assert.equal(decls?.[1]?.name, "edit");

const sysParts = request.request.systemInstruction?.parts;
assert.ok(sysParts, "systemInstruction parts must exist");
assert.equal(sysParts?.[0]?.text, "You are an expert developer.");

// 2. Backward compatibility with legacy Context (Pi < 0.86.0)
const legacyContext: Context = {
  systemPrompt: "You are a legacy assistant.",
  tools: [bashTool],
  messages: [
    {
      role: "user" as const,
      content: "Run ls",
      timestamp: Date.now(),
    },
  ],
};

const legacyReq = buildRequest(
  testModel,
  legacyContext,
  "test-project",
  {},
  "gemini-3.8-flash",
);

assert.ok(legacyReq.request.tools, "request.tools must not be undefined for legacy context");
const legacyDecls = legacyReq.request.tools?.[0]?.functionDeclarations;
assert.equal(legacyDecls?.length, 1);
assert.equal(legacyDecls?.[0]?.name, "bash");
assert.equal(legacyReq.request.systemInstruction?.parts?.[0]?.text, "You are a legacy assistant.");

// 3. Dynamic tool additions and removals across system messages
const multiTurnContext: Context = {
  messages: [
    {
      role: "system" as const,
      content: "Initial system prompt",
      toolsAdded: [bashTool],
      timestamp: 1000,
    } as any,
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
    } as any,
    {
      role: "user" as const,
      content: "now edit file",
      timestamp: 1004,
    },
  ],
};

const dynamicReq = buildRequest(
  testModel,
  multiTurnContext,
  "test-project",
  {},
  "gemini-3.8-flash",
);

assert.ok(dynamicReq.request.tools);
const dynamicDecls = dynamicReq.request.tools?.[0]?.functionDeclarations;
assert.equal(dynamicDecls?.length, 1);
assert.equal(dynamicDecls?.[0]?.name, "edit", "bash should have been removed, only edit should remain");

// 4. No tools in TranscriptContext -> request.tools is undefined
const noToolsContext: Context = {
  messages: [
    {
      role: "system" as const,
      content: "Just talk.",
      timestamp: Date.now(),
    } as any,
    {
      role: "user" as const,
      content: "Tell me a joke.",
      timestamp: Date.now(),
    },
  ],
};

const noToolsReq = buildRequest(
  testModel,
  noToolsContext,
  "test-project",
  {},
  "gemini-3.8-flash",
);

assert.equal(noToolsReq.request.tools, undefined, "request.tools must be undefined when no tools declared");

console.log("scripts/test-transcript-context.ts: all TranscriptContext and issue #52 tests passed cleanly");
