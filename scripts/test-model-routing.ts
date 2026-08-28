import assert from "node:assert/strict";
import type { Api, Context, Model, Tool } from "@earendil-works/pi-ai";
import { defaultProjectId, stableProjectId } from "../src/client/index.js";
import { StopReason } from "../src/types/enums.js";
import {
  ANTIGRAVITY_MODELS,
  getMaxOutputTokens,
  getAntigravityRequestModelId,
  getFallbackRuntimeModel,
} from "../src/models/index.js";
import {
  buildRequest,
  convertMessages,
  convertTools,
  friendlyAntigravityError,
  mapStopReason,
} from "../src/stream/index.js";

const route = (model: string, effort?: string) => getAntigravityRequestModelId(model, effort);

const routeCases: Array<[string, string | undefined, string]> = [
  ["gemini-3.7-flash", undefined, "gemini-3.7-flash-tiered"],
  ["gemini-3.7-flash", "off", "gemini-3.7-flash-tiered"],
  ["gemini-3.7-flash", "minimal", "gemini-3.7-flash-tiered"],
  ["gemini-3.7-flash", "low", "gemini-3.7-flash-tiered"],
  ["gemini-3.7-flash", "medium", "gemini-3.7-flash-tiered"],
  ["gemini-3.7-flash", "high", "gemini-3.7-flash-tiered"],
  ["gemini-3.7-flash", "xhigh", "gemini-3.7-flash-tiered"],
  ["gemini-3.6-flash", undefined, "gemini-3.6-flash-low"],
  ["gemini-3.6-flash", "off", "gemini-3.6-flash-low"],
  ["gemini-3.6-flash", "minimal", "gemini-3.6-flash-low"],
  ["gemini-3.6-flash", "low", "gemini-3.6-flash-low"],
  ["gemini-3.6-flash", "medium", "gemini-3.6-flash-medium"],
  ["gemini-3.6-flash", "high", "gemini-3.6-flash-high"],
  ["gemini-3.6-flash", "xhigh", "gemini-3.6-flash-high"],
  ["gemini-3.5-flash", undefined, "gemini-3.5-flash-extra-low"],
  ["gemini-3.5-flash", "off", "gemini-3.5-flash-extra-low"],
  ["gemini-3.5-flash", "minimal", "gemini-3.5-flash-extra-low"],
  ["gemini-3.5-flash", "low", "gemini-3.5-flash-low"],
  ["gemini-3.5-flash", "medium", "gemini-3.5-flash-low"],
  ["gemini-3.5-flash", "high", "gemini-3-flash-agent"],
  ["gemini-3.5-flash", "xhigh", "gemini-3-flash-agent"],
  ["gemini-3.1-pro", "medium", "gemini-3.1-pro-low"],
  ["gemini-3.1-pro", "high", "gemini-pro-agent"],
  ["gemini-3.1-pro", "xhigh", "gemini-pro-agent"],
  ["claude-sonnet-4-6", "xhigh", "claude-sonnet-4-6"],
  ["claude-opus-4-6", "high", "claude-opus-4-6-thinking"],
  ["gpt-oss-120b", "high", "gpt-oss-120b-medium"],
  ["unknown-model", "high", "unknown-model"],
];

for (const [model, effort, expected] of routeCases) {
  assert.equal(route(model, effort), expected, `${model} (${effort ?? "default"})`);
}

const modelIds = new Set(ANTIGRAVITY_MODELS.map((model) => model.id));
const expectedModels = [
  "gemini-3.7-flash",
  "gemini-3.6-flash",
  "gemini-3.5-flash",
  "gemini-3.1-pro",
  "claude-sonnet-4-6",
  "claude-opus-4-6",
  "gpt-oss-120b",
];
assert.equal(
  modelIds.size,
  expectedModels.length,
  `unexpected model count: ${[...modelIds].join(",")}`,
);
for (const expected of expectedModels) {
  assert.ok(modelIds.has(expected), `missing selectable model: ${expected}`);
}

const expectedThinkingLevels: Record<string, string[]> = {
  "gemini-3.7-flash": ["low", "medium", "high"],
  "gemini-3.6-flash": ["low", "medium", "high"],
  "gemini-3.5-flash": ["low", "medium", "high"],
  "gemini-3.1-pro": ["low", "high"],
  "claude-opus-4-6": ["high"],
  "claude-sonnet-4-6": ["high"],
  "gpt-oss-120b": ["medium"],
};
for (const configuredModel of ANTIGRAVITY_MODELS) {
  const map = configuredModel.thinkingLevelMap;
  const supportedLevels = Object.entries(map ?? {})
    .filter(([, value]) => value !== null)
    .map(([level]) => level);
  assert.deepEqual(
    supportedLevels,
    expectedThinkingLevels[configuredModel.id],
    `${configuredModel.id} must only expose backend-supported thinking levels`,
  );
}

const booleanUnionTool = {
  name: "boolean_union",
  description: "Exercises Pi's boolean enum schema shape.",
  parameters: {
    type: "object",
    properties: {
      value: {
        anyOf: [
          { type: "string", enum: ["auto"] },
          { type: "boolean", enum: [false] },
        ],
      },
    },
  },
} as Tool;
const customTools = convertTools([booleanUnionTool], true);
const customDeclaration = customTools?.[0]?.functionDeclarations[0];
assert.ok(customDeclaration?.parameters, "custom backends must use legacy parameters");
assert.deepEqual(customDeclaration?.parameters, {
  type: "object",
  properties: { value: {} },
});
assert.equal(customDeclaration?.parametersJsonSchema, undefined);

const geminiDeclaration = convertTools([booleanUnionTool])?.[0]?.functionDeclarations[0];
assert.ok(geminiDeclaration?.parametersJsonSchema, "Gemini must use parametersJsonSchema");
assert.equal(geminiDeclaration?.parameters, undefined);
assert.deepEqual(geminiDeclaration?.parametersJsonSchema, booleanUnionTool.parameters);

const openObjectTool = {
  name: "todo_like",
  description: "Open object fields",
  parameters: {
    type: "object",
    properties: {
      metadata: {
        type: "object",
        patternProperties: { "^.*$": {} },
        additionalProperties: true,
        description: "Arbitrary metadata",
      },
      label: { type: "string", maxLength: 60, default: "x" },
      limit: { type: "number", default: 3, minimum: 1 },
    },
    additionalProperties: false,
  },
} as Tool;
const openObjectDecl = convertTools([openObjectTool], true)?.[0]?.functionDeclarations[0];
assert.deepEqual(openObjectDecl?.parameters, {
  type: "object",
  properties: {
    metadata: { type: "object", description: "Arbitrary metadata" },
    label: { type: "string" },
    limit: { type: "number" },
  },
});

const nullableTool = {
  name: "nullable_probe",
  description: "OpenAPI-style nullable + type union that Claude bridge rejects.",
  parameters: {
    type: "object",
    properties: {
      path: { type: ["string", "null"], nullable: true, format: "uri" },
      mode: { type: "string", enum: ["a", "b"], default: "a" },
    },
    required: ["path"],
    additionalProperties: false,
  },
} as Tool;
const nullableDecl = convertTools([nullableTool], true)?.[0]?.functionDeclarations[0];
assert.deepEqual(nullableDecl?.parameters, {
  type: "object",
  properties: {
    path: { type: "string" },
    mode: { type: "string", enum: ["a", "b"] },
  },
  required: ["path"],
});

// Test local $ref / $defs dereferencing
const refTool = {
  name: "ref_probe",
  description: "Tool with local $ref and $defs",
  parameters: {
    type: "object",
    properties: {
      status: { $ref: "#/$defs/Status" },
    },
    $defs: {
      Status: { type: "string", enum: ["open", "closed"] },
    },
  },
} as Tool;
const dereferencedGemini = convertTools([refTool])?.[0]?.functionDeclarations[0];
assert.deepEqual(dereferencedGemini?.parametersJsonSchema, {
  type: "object",
  properties: {
    status: { type: "string", enum: ["open", "closed"] },
  },
});
const dereferencedCustom = convertTools([refTool], true)?.[0]?.functionDeclarations[0];
assert.deepEqual(dereferencedCustom?.parameters, {
  type: "object",
  properties: {
    status: { type: "string", enum: ["open", "closed"] },
  },
});
assert.match(
  friendlyAntigravityError(400, JSON.stringify({ error: { message: "Unknown name nullable" } })),
  /Unknown name nullable/i,
);

assert.equal(mapStopReason("STOP"), StopReason.Stop);
assert.equal(mapStopReason("MAX_TOKENS"), StopReason.Length);
assert.equal(mapStopReason("OTHER"), StopReason.Error);
assert.equal(mapStopReason(undefined), StopReason.Stop);

assert.match(friendlyAntigravityError(401, "nope"), /authentication failed/i);
assert.match(
  friendlyAntigravityError(429, "Individual quota reached. Resets in 1h"),
  /Quota reached/,
);
assert.match(
  friendlyAntigravityError(400, JSON.stringify({ error: { message: "Unknown name anyOf" } })),
  /request format was rejected/i,
);
assert.match(
  friendlyAntigravityError(404, "Requested entity was not found"),
  /not available right now/i,
);

const seedA = stableProjectId("user@example.com");
const seedB = stableProjectId("user@example.com");
const seedC = stableProjectId("other@example.com");
assert.equal(seedA, seedB);
assert.notEqual(seedA, seedC);
assert.match(seedA, /^[0-9a-f-]{36}$/);

const model = {
  id: "claude-sonnet-4-6",
  name: "Claude",
  api: "antigravity-api",
  provider: "antigravity",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200000,
  maxTokens: 64000,
} as Model<Api>;

const context = {
  messages: [
    { role: "user", content: "hello", timestamp: Date.now() },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "plan" },
        { type: "text", text: "hi" },
        { type: "toolCall", id: "call-1", name: "read", arguments: { path: "a.ts" } },
      ],
      api: "antigravity-api",
      provider: "antigravity",
      model: "claude-sonnet-4-6",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "toolUse",
      timestamp: Date.now(),
    },
    {
      role: "toolResult",
      toolCallId: "call-1",
      toolName: "read",
      content: [{ type: "text", text: "file contents" }],
      isError: false,
      timestamp: Date.now(),
    },
  ],
} as Context;

const contents = convertMessages(model, context, "claude-sonnet-4-6");
assert.equal(contents.length, 3);
assert.equal(contents[0]?.role, "user");
assert.deepEqual(contents[1]?.parts[0], { thought: true, text: "plan" });
assert.ok(
  contents[1]?.parts.some((part) => "functionCall" in part && part.functionCall.id === "call-1"),
);
assert.ok(
  contents[2]?.parts.some(
    (part) =>
      "functionResponse" in part &&
      part.functionResponse.id === "call-1" &&
      "output" in part.functionResponse.response,
  ),
);

// Test consecutive same-role message merging
const consecutiveContext = {
  messages: [
    { role: "user", content: "question 1", timestamp: Date.now() },
    { role: "user", content: "question 2", timestamp: Date.now() },
    {
      role: "assistant",
      content: [{ type: "text", text: "answer 1" }],
      api: "antigravity-api",
      provider: "antigravity",
      model: "claude-sonnet-4-6",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    },
    {
      role: "assistant",
      content: [{ type: "text", text: "answer 2" }],
      api: "antigravity-api",
      provider: "antigravity",
      model: "claude-sonnet-4-6",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    },
  ],
} as Context;
const mergedContents = convertMessages(model, consecutiveContext, "claude-sonnet-4-6");
assert.equal(mergedContents.length, 2);
assert.equal(mergedContents[0]?.role, "user");
assert.equal(mergedContents[0]?.parts.length, 2);
assert.equal(mergedContents[1]?.role, "model");
assert.equal(mergedContents[1]?.parts.length, 2);

// Test Base64 Image data URL prefix stripping
const imageContext = {
  messages: [
    {
      role: "user",
      content: [
        { type: "text", text: "check image" },
        { type: "image", data: "data:image/jpeg;base64,/9j/4AAQSkZJRg==", mimeType: "image/jpeg" },
      ],
      timestamp: Date.now(),
    },
  ],
} as Context;
const imageContents = convertMessages(model, imageContext, "gemini-3.7-flash-tiered");
assert.equal(imageContents[0]?.parts.length, 2);
const imgPart = imageContents[0]?.parts[1];
assert.ok(imgPart && "inlineData" in imgPart);
assert.equal(imgPart.inlineData.data, "/9j/4AAQSkZJRg==");
assert.equal(imgPart.inlineData.mimeType, "image/jpeg");

// Test max output token limits per runtime model
assert.equal(getMaxOutputTokens("gemini-3.7-flash", "gemini-3.7-flash-tiered"), 65536);
assert.equal(getMaxOutputTokens("gemini-3.6-flash", "gemini-3.6-flash-low"), 65536);
assert.equal(getMaxOutputTokens("gemini-3.1-pro", "gemini-3.1-pro-low"), 65535);
assert.equal(getMaxOutputTokens("claude-sonnet-4-6", "claude-sonnet-4-6"), 64000);
assert.equal(getMaxOutputTokens("gpt-oss-120b", "gpt-oss-120b-medium"), 32768);

// Test fallback runtime models
assert.equal(getFallbackRuntimeModel("gemini-3.7-flash-low"), "gemini-3.6-flash-low");
assert.equal(getFallbackRuntimeModel("gemini-3.7-flash-medium"), "gemini-3.6-flash-medium");
assert.equal(getFallbackRuntimeModel("gemini-3.7-flash-high"), "gemini-3.6-flash-high");
assert.equal(
  getFallbackRuntimeModel("gemini-3.7-flash-tiered", "medium"),
  "gemini-3.6-flash-medium",
);
assert.equal(getFallbackRuntimeModel("gemini-3.7-flash"), "gemini-3.6-flash-low");
assert.equal(getFallbackRuntimeModel("gemini-3.6-flash-low"), undefined);
assert.equal(getFallbackRuntimeModel("claude-sonnet-4-6"), undefined);

// Test buildRequest output token clamping
const dummyContext: Context = {
  messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
};

// Case A: Omitted maxTokens -> uses model's max output token limit
const reqA = buildRequest(model, dummyContext, "test-proj", {}, "claude-sonnet-4-6");
assert.equal(reqA.request.generationConfig?.maxOutputTokens, 64000);

// Case B: Oversized maxTokens (e.g. 100000) -> clamped to model ceiling
const reqB = buildRequest(
  model,
  dummyContext,
  "test-proj",
  { maxTokens: 100000 },
  "claude-sonnet-4-6",
);
assert.equal(reqB.request.generationConfig?.maxOutputTokens, 64000);

// Case C: Small maxTokens (e.g. 2048) -> preserved
const reqC = buildRequest(
  model,
  dummyContext,
  "test-proj",
  { maxTokens: 2048 },
  "claude-sonnet-4-6",
);
assert.equal(reqC.request.generationConfig?.maxOutputTokens, 2048);

// Case D: Gemini 3.1 Pro oversized (e.g. 65536) -> clamped to 65535
const proModel = { ...model, id: "gemini-3.1-pro", maxTokens: 65535 };
const reqD = buildRequest(
  proModel,
  dummyContext,
  "test-proj",
  { maxTokens: 65536 },
  "gemini-3.1-pro-low",
);
assert.equal(reqD.request.generationConfig?.maxOutputTokens, 65535);

// Case E: Gemini 3.7 uses its tiered runtime and sends effort in thinkingConfig.
const flash37Model = { ...model, id: "gemini-3.7-flash", maxTokens: 65536 };
for (const [reasoning, thinkingLevel] of [
  ["low", "LOW"],
  ["medium", "MEDIUM"],
  ["high", "HIGH"],
] as const) {
  const request = buildRequest(
    flash37Model,
    dummyContext,
    "test-proj",
    { reasoning },
    "gemini-3.7-flash-tiered",
  );
  assert.equal(request.request.generationConfig?.thinkingConfig?.thinkingLevel, thinkingLevel);
}

// Case F: Cross-provider unsigned tool calls are converted to user observations on Gemini 3+
const unsignedToolContext = {
  messages: [
    { role: "user", content: "read file", timestamp: Date.now() },
    {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "call-prev-1",
          name: "read",
          arguments: { path: "main.ts" },
        },
      ],
      api: "openai-responses",
      provider: "openai",
      model: "gpt-4o",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "toolUse",
      timestamp: Date.now(),
    },
    {
      role: "toolResult",
      toolCallId: "call-prev-1",
      toolName: "read",
      content: [{ type: "text", text: "file content" }],
      isError: false,
      timestamp: Date.now(),
    },
  ],
} as unknown as Context;
const convertedUnsigned = convertMessages(flash37Model, unsignedToolContext, "gemini-3.7-flash-tiered");
assert.equal(convertedUnsigned.length, 1);
assert.equal(convertedUnsigned[0]?.role, "user");
assert.ok(convertedUnsigned[0]?.parts.some((p) => "text" in p && p.text.includes("Observation from `read`")));

// Case G: Parallel tool calls where only the first call has thoughtSignature
const validSig = "QkFTRTY0LXRlc3Qtc2lnbmF0dXJlLXRlc3QxMjM0NTY=";
const parallelSignedContext = {
  messages: [
    { role: "user", content: "read two files", timestamp: Date.now() },
    {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "call-1",
          name: "read",
          arguments: { path: "a.ts" },
          thoughtSignature: validSig,
        },
        {
          type: "toolCall",
          id: "call-2",
          name: "read",
          arguments: { path: "b.ts" },
        },
      ],
      api: "antigravity-api",
      provider: "antigravity",
      model: "gemini-3.7-flash",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "toolUse",
      timestamp: Date.now(),
    },
    {
      role: "toolResult",
      toolCallId: "call-1",
      toolName: "read",
      content: [{ type: "text", text: "content a" }],
      isError: false,
      timestamp: Date.now(),
    },
    {
      role: "toolResult",
      toolCallId: "call-2",
      toolName: "read",
      content: [{ type: "text", text: "content b" }],
      isError: false,
      timestamp: Date.now(),
    },
  ],
} as unknown as Context;
const convertedParallel = convertMessages(flash37Model, parallelSignedContext, "gemini-3.7-flash-tiered");
assert.equal(convertedParallel.length, 3);
assert.equal(convertedParallel[1]?.role, "model");
assert.equal(convertedParallel[1]?.parts.length, 2);
assert.ok(convertedParallel[1]?.parts.every((p) => "functionCall" in p), "all parallel calls in signed turn remain functionCalls");
assert.equal(convertedParallel[2]?.role, "user");
assert.equal(convertedParallel[2]?.parts.length, 2);
assert.ok(convertedParallel[2]?.parts.every((p) => "functionResponse" in p), "all parallel results remain functionResponses");

// Case H: Parallel tool calls with reversed signature placement (first unsigned, second signed)
const parallelReversedContext = {
  messages: [
    { role: "user", content: "read files", timestamp: Date.now() },
    {
      role: "assistant",
      content: [
        { type: "toolCall", id: "call-r1", name: "read", arguments: { path: "a.ts" } },
        { type: "toolCall", id: "call-r2", name: "read", arguments: { path: "b.ts" }, thoughtSignature: validSig },
      ],
      api: "antigravity-api",
      provider: "antigravity",
      model: "gemini-3.7-flash",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "toolUse",
      timestamp: Date.now(),
    },
    { role: "toolResult", toolCallId: "call-r1", toolName: "read", content: [{ type: "text", text: "a" }], isError: false, timestamp: Date.now() },
    { role: "toolResult", toolCallId: "call-r2", toolName: "read", content: [{ type: "text", text: "b" }], isError: false, timestamp: Date.now() },
  ],
} as unknown as Context;
const convertedReversed = convertMessages(flash37Model, parallelReversedContext, "gemini-3.7-flash-tiered");
assert.ok(!convertedReversed.some((c) => c.parts.some((p) => "functionCall" in p)), "reversed signature calls downgrade to observations");

// Case I: Signed thinking block with unsigned tool call
const signedThinkingUnsignedCallContext = {
  messages: [
    { role: "user", content: "do action", timestamp: Date.now() },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "plan", thinkingSignature: validSig },
        { type: "toolCall", id: "call-u1", name: "read", arguments: { path: "a.ts" } },
      ],
      api: "antigravity-api",
      provider: "antigravity",
      model: "gemini-3.7-flash",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "toolUse",
      timestamp: Date.now(),
    },
    { role: "toolResult", toolCallId: "call-u1", toolName: "read", content: [{ type: "text", text: "result" }], isError: false, timestamp: Date.now() },
  ],
} as unknown as Context;
const convertedSignedThinking = convertMessages(flash37Model, signedThinkingUnsignedCallContext, "gemini-3.7-flash-tiered");
assert.ok(!convertedSignedThinking.some((c) => c.parts.some((p) => "functionCall" in p)), "thinking signature does not mark unsigned toolCall as signed");

// Case J: Sibling call with malformed/corrupted signature
const malformedSiblingContext = {
  messages: [
    { role: "user", content: "read files", timestamp: Date.now() },
    {
      role: "assistant",
      content: [
        { type: "toolCall", id: "call-m1", name: "read", arguments: { path: "a.ts" }, thoughtSignature: validSig },
        { type: "toolCall", id: "call-m2", name: "read", arguments: { path: "b.ts" }, thoughtSignature: "invalid!!base64" },
      ],
      api: "antigravity-api",
      provider: "antigravity",
      model: "gemini-3.7-flash",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "toolUse",
      timestamp: Date.now(),
    },
    { role: "toolResult", toolCallId: "call-m1", toolName: "read", content: [{ type: "text", text: "a" }], isError: false, timestamp: Date.now() },
    { role: "toolResult", toolCallId: "call-m2", toolName: "read", content: [{ type: "text", text: "b" }], isError: false, timestamp: Date.now() },
  ],
} as unknown as Context;
const convertedMalformed = convertMessages(flash37Model, malformedSiblingContext, "gemini-3.7-flash-tiered");
assert.ok(!convertedMalformed.some((c) => c.parts.some((p) => "functionCall" in p)), "malformed sibling signature causes downgrade to observation");

console.log(
  `model routing: ${routeCases.length} cases, tool schema, errors, project ids, token clamping, and message conversion passed`,
);
