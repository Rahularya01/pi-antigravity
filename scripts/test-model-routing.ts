import type { Api, Context, Model, Tool } from "@earendil-works/pi-ai";
import {
  antigravityHeaders,
  defaultProjectId,
  defaultUserAgent,
  stableProjectId,
} from "../src/client/index.js";
import { getLastDiagnostics, resetDiagnosticsForTests } from "../src/diagnostics/index.js";
import { GeminiToolCallingMode, StopReason, ToolChoice } from "../src/types/enums.js";
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
import {
  antigravityRequestEnvelope,
  clearSessionTrajectoryMap,
} from "../src/utils/util.js";

function fail(message: string): never {
  throw new Error(message);
}

const assert = {
  equal(actual: unknown, expected: unknown, message?: string) {
    if (actual !== expected) fail(message ?? `expected ${String(expected)}, got ${String(actual)}`);
  },
  notEqual(actual: unknown, expected: unknown) {
    if (actual === expected) fail(`expected values not to be equal: ${String(actual)}`);
  },
  deepEqual(actual: unknown, expected: unknown, message?: string) {
    if (!Bun.deepEquals(actual, expected)) {
      fail(message ?? `expected ${Bun.inspect(expected)}, got ${Bun.inspect(actual)}`);
    }
  },
  ok(value: unknown, message?: string) {
    if (!value) fail(message ?? "expected a truthy value");
  },
  match(actual: string, pattern: RegExp) {
    if (!pattern.test(actual)) fail(`expected ${actual} to match ${pattern}`);
  },
};

const route = (model: string, effort?: string) => getAntigravityRequestModelId(model, effort);

const routeCases: Array<[string, string | undefined, string]> = [
  ["gemini-3.8-flash", undefined, "gemini-3.8-flash-low"],
  ["gemini-3.8-flash", "off", "gemini-3.8-flash-low"],
  ["gemini-3.8-flash", "minimal", "gemini-3.8-flash-low"],
  ["gemini-3.8-flash", "low", "gemini-3.8-flash-low"],
  ["gemini-3.8-flash", "medium", "gemini-3.8-flash-medium"],
  ["gemini-3.8-flash", "high", "gemini-3.8-flash-high"],
  ["gemini-3.8-flash", "xhigh", "gemini-3.8-flash-high"],
  ["gemini-3.7-flash", undefined, "gemini-3.7-flash-low"],
  ["gemini-3.7-flash", "off", "gemini-3.7-flash-low"],
  ["gemini-3.7-flash", "minimal", "gemini-3.7-flash-low"],
  ["gemini-3.7-flash", "low", "gemini-3.7-flash-low"],
  ["gemini-3.7-flash", "medium", "gemini-3.7-flash-medium"],
  ["gemini-3.7-flash", "high", "gemini-3.7-flash-high"],
  ["gemini-3.7-flash", "xhigh", "gemini-3.7-flash-high"],
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
  ["gemini-3.5-flash", "low", "gemini-3.5-flash-extra-low"],
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
  "gemini-3.8-flash",
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
  "gemini-3.8-flash": ["low", "medium", "high"],
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

// Resolve complete JSON Pointers, including RFC 6901 escaped property names.
const nestedPointerTool = {
  name: "nested_pointer_probe",
  description: "Tool with an escaped local JSON Pointer",
  parameters: {
    type: "object",
    properties: {
      accent: { $ref: "#/$defs/Theme/properties/accent~1color" },
    },
    $defs: {
      Theme: {
        type: "object",
        properties: {
          "accent/color": { type: "string" },
        },
      },
    },
  },
} as Tool;
assert.deepEqual(convertTools([nestedPointerTool])?.[0]?.functionDeclarations[0]?.parametersJsonSchema, {
  type: "object",
  properties: { accent: { type: "string" } },
});

// One malformed declaration must not prevent healthy tools from being sent.
const danglingRefTool = {
  name: "dangling_ref_probe",
  description: "Tool with a missing local reference",
  parameters: {
    type: "object",
    properties: { theme: { $ref: "#/$defs/DesignTheme" } },
  },
} as Tool;
resetDiagnosticsForTests();
const declarationsWithoutDangling = convertTools([refTool, danglingRefTool])?.[0]?.functionDeclarations;
assert.equal(declarationsWithoutDangling?.length, 1);
assert.equal(declarationsWithoutDangling?.[0]?.name, "ref_probe");
assert.match(getLastDiagnostics().toolSchemaWarnings || "", /dangling_ref_probe.*not present/i);
assert.equal(convertTools([danglingRefTool]), undefined);

// Recursive references cannot be made self-contained for the Antigravity backend.
const cyclicRefTool = {
  name: "cyclic_ref_probe",
  description: "Tool with a circular local reference",
  parameters: {
    type: "object",
    properties: { value: { $ref: "#/$defs/A" } },
    $defs: {
      A: { $ref: "#/$defs/B" },
      B: { $ref: "#/$defs/A" },
    },
  },
} as Tool;
assert.equal(convertTools([cyclicRefTool]), undefined);

/** Return every unresolved reference emitted in a converted declaration. */
function unresolvedRefs(value: unknown, path = "$"): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => unresolvedRefs(item, `${path}[${index}]`));
  }
  if (!value || typeof value !== "object") return [];

  const schema = value as Record<string, unknown>;
  const own = typeof schema.$ref === "string" ? [`${path}: ${schema.$ref}`] : [];
  return [
    ...own,
    ...Object.entries(schema).flatMap(([key, child]) => unresolvedRefs(child, `${path}.${key}`)),
  ];
}

// Regression: mirrors Stitch's design-system schema, including a nested shared definition.
const stitchDesignSystemTool = {
  name: "stitch_design_system_probe",
  description: "Schema representative of Stitch design-system tools",
  parameters: {
    type: "object",
    properties: {
      designSystem: {
        type: "object",
        properties: {
          theme: {
            $ref: "#/$defs/DesignTheme",
            description: "Required theme configuration",
          },
        },
        required: ["theme"],
      },
    },
    required: ["designSystem"],
    $defs: {
      Font: { type: "string", enum: ["INTER", "MANROPE"] },
      DesignTheme: {
        type: "object",
        properties: {
          bodyFont: { $ref: "#/$defs/Font" },
          headlineFont: { $ref: "#/$defs/Font" },
          colorMode: { type: "string", enum: ["LIGHT", "DARK"] },
        },
        required: ["bodyFont", "headlineFont", "colorMode"],
      },
    },
  },
} as Tool;
const stitchSchema = convertTools([stitchDesignSystemTool])?.[0]?.functionDeclarations[0]
  ?.parametersJsonSchema as Record<string, unknown>;
assert.ok(stitchSchema);
assert.deepEqual(unresolvedRefs(stitchSchema), []);
assert.deepEqual(
  (stitchSchema.properties as Record<string, Record<string, unknown>>).designSystem.properties,
  {
    theme: {
      type: "object",
      properties: {
        bodyFont: { type: "string", enum: ["INTER", "MANROPE"] },
        headlineFont: { type: "string", enum: ["INTER", "MANROPE"] },
        colorMode: { type: "string", enum: ["LIGHT", "DARK"] },
      },
      required: ["bodyFont", "headlineFont", "colorMode"],
      description: "Required theme configuration",
    },
  },
);

// Resolve both Draft-07 definitions and repeated nested references without global visitation.
const sharedReferenceTool = {
  name: "shared_reference_probe",
  description: "Tool with repeated references to a shared nested schema",
  parameters: {
    type: "object",
    properties: {
      primary: { $ref: "#/definitions/Theme" },
      secondary: { $ref: "#/definitions/Theme" },
      accents: { type: "array", items: { $ref: "#/definitions/Color" } },
    },
    definitions: {
      Color: { type: "string", enum: ["red", "blue"] },
      Theme: {
        type: "object",
        properties: {
          foreground: { $ref: "#/definitions/Color" },
          background: { $ref: "#/definitions/Color" },
        },
      },
    },
  },
} as Tool;
const sharedSchema = convertTools([sharedReferenceTool])?.[0]?.functionDeclarations[0]
  ?.parametersJsonSchema as Record<string, unknown>;
assert.ok(sharedSchema);
assert.deepEqual(unresolvedRefs(sharedSchema), []);
assert.deepEqual(
  (sharedSchema.properties as Record<string, Record<string, unknown>>).accents.items,
  { type: "string", enum: ["red", "blue"] },
);

// Draft-07 dependencies may contain schemas with references or property-name arrays.
const dependencyReferenceTool = {
  name: "dependency_reference_probe",
  description: "Tool with a referenced dependency schema",
  parameters: {
    type: "object",
    properties: {
      enabled: { type: "boolean" },
      mode: { type: "string" },
    },
    dependencies: {
      enabled: { $ref: "#/definitions/EnabledOptions" },
      mode: ["enabled"],
    },
    definitions: {
      EnabledOptions: {
        type: "object",
        properties: { threshold: { type: "number" } },
      },
    },
  },
} as Tool;
const dependencySchema = convertTools([dependencyReferenceTool])?.[0]?.functionDeclarations[0]
  ?.parametersJsonSchema as Record<string, unknown>;
assert.ok(dependencySchema);
assert.deepEqual(unresolvedRefs(dependencySchema), []);
assert.deepEqual(dependencySchema.dependencies, {
  enabled: {
    type: "object",
    properties: { threshold: { type: "number" } },
  },
  mode: ["enabled"],
});

// References embedded in JSON Schema combinators are traversed like MCP tool schemas from Zod/Ajv.
const combinatorReferenceTool = {
  name: "combinator_reference_probe",
  description: "Tool with refs in schema combinators",
  parameters: {
    type: "object",
    properties: {
      value: {
        anyOf: [
          { $ref: "#/$defs/Text" },
          { type: "array", items: { $ref: "#/$defs/Text" } },
        ],
      },
      constrained: {
        allOf: [{ $ref: "#/$defs/Text" }],
      },
    },
    $defs: { Text: { type: "string", minLength: 1 } },
  },
} as Tool;
const combinatorSchema = convertTools([combinatorReferenceTool])?.[0]?.functionDeclarations[0]
  ?.parametersJsonSchema;
assert.ok(combinatorSchema);
assert.deepEqual(unresolvedRefs(combinatorSchema), []);

// RFC 6901 supports both '~' and '/' escaping in property names.
const fullyEscapedPointerTool = {
  name: "fully_escaped_pointer_probe",
  description: "Tool with a fully escaped JSON Pointer",
  parameters: {
    type: "object",
    properties: { value: { $ref: "#/$defs/Envelope/properties/a~0b~1c" } },
    $defs: {
      Envelope: { type: "object", properties: { "a~b/c": { type: "boolean" } } },
    },
  },
} as Tool;
assert.deepEqual(
  convertTools([fullyEscapedPointerTool])?.[0]?.functionDeclarations[0]?.parametersJsonSchema,
  { type: "object", properties: { value: { type: "boolean" } } },
);

// RFC 6901 array tokens resolve schemas selected from combinator arrays.
const arrayPointerTool = {
  name: "array_pointer_probe",
  description: "Tool with an array-index local JSON Pointer",
  parameters: {
    type: "object",
    properties: { value: { $ref: "#/$defs/Value/anyOf/0" } },
    $defs: { Value: { anyOf: [{ type: "integer" }, { type: "string" }] } },
  },
} as Tool;
assert.deepEqual(
  convertTools([arrayPointerTool])?.[0]?.functionDeclarations[0]?.parametersJsonSchema,
  { type: "object", properties: { value: { type: "integer" } } },
);

// Property names may themselves be JSON Schema keywords and must remain ordinary property names.
const keywordNamedPropertiesTool = {
  name: "keyword_named_properties_probe",
  description: "Tool with keyword-like property names",
  parameters: {
    type: "object",
    properties: {
      definitions: { type: "string" },
      $ref: { type: "number" },
    },
  },
} as Tool;
assert.deepEqual(
  convertTools([keywordNamedPropertiesTool])?.[0]?.functionDeclarations[0]?.parametersJsonSchema,
  {
    type: "object",
    properties: { definitions: { type: "string" }, $ref: { type: "number" } },
  },
);

// Bound fan-out from untrusted MCP schemas instead of expanding references indefinitely.
const expansionBudgetTool = {
  name: "expansion_budget_probe",
  description: "Tool with excessive repeated references",
  parameters: {
    type: "object",
    properties: {
      value: {
        anyOf: Array.from({ length: 4_000 }, () => ({ $ref: "#/$defs/Value" })),
      },
    },
    $defs: { Value: { type: "string" } },
  },
} as Tool;
resetDiagnosticsForTests();
assert.equal(convertTools([expansionBudgetTool]), undefined);
assert.match(getLastDiagnostics().toolSchemaWarnings || "", /expansion exceeded.*nodes/i);

// MCP servers can expose external or malformed refs. They are isolated instead of poisoning all tools.
const externalRefTool = {
  name: "external_ref_probe",
  description: "Tool with an unsupported external reference",
  parameters: {
    type: "object",
    properties: { value: { $ref: "https://example.test/schema.json#/Value" } },
  },
} as Tool;
const schemasWithExternalRef = convertTools([refTool, externalRefTool])?.[0]?.functionDeclarations;
assert.equal(schemasWithExternalRef?.length, 1);
assert.equal(schemasWithExternalRef?.[0]?.name, "ref_probe");

// The legacy Claude/GPT bridge receives the same fully inlined schema before its allowlist pass.
const legacyStitchSchema = convertTools([stitchDesignSystemTool], true)?.[0]
  ?.functionDeclarations[0]?.parameters as Record<string, unknown>;
assert.ok(legacyStitchSchema);
assert.deepEqual(unresolvedRefs(legacyStitchSchema), []);
assert.deepEqual(
  ((legacyStitchSchema.properties as Record<string, Record<string, unknown>>).designSystem
    .properties as Record<string, Record<string, unknown>>).theme.type,
  "object",
);

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
assert.equal(getMaxOutputTokens("gemini-3.8-flash", "gemini-3.8-flash-low"), 65536);
assert.equal(getMaxOutputTokens("gemini-3.7-flash", "gemini-3.7-flash-tiered"), 65536);
assert.equal(getMaxOutputTokens("gemini-3.6-flash", "gemini-3.6-flash-low"), 65536);
assert.equal(getMaxOutputTokens("gemini-3.1-pro", "gemini-3.1-pro-low"), 65535);
assert.equal(getMaxOutputTokens("claude-sonnet-4-6", "claude-sonnet-4-6"), 64000);
assert.equal(getMaxOutputTokens("gpt-oss-120b", "gpt-oss-120b-medium"), 32768);

// Test fallback runtime models
assert.equal(getFallbackRuntimeModel("gemini-3.8-flash-low"), "gemini-3.7-flash-low");
assert.equal(getFallbackRuntimeModel("gemini-3.8-flash-medium"), "gemini-3.7-flash-medium");
assert.equal(getFallbackRuntimeModel("gemini-3.8-flash-high"), "gemini-3.7-flash-high");
assert.equal(getFallbackRuntimeModel("gemini-3.8-flash"), "gemini-3.7-flash-low");
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

// Case E: Gemini models send thinkingBudget (high: -1, medium: 4000, low: 1000, off: 0)
const flash38Model = { ...model, id: "gemini-3.8-flash", maxTokens: 65536 };
for (const [reasoning, thinkingBudget, runtime] of [
  ["low", 1000, "gemini-3.8-flash-low"],
  ["medium", 4000, "gemini-3.8-flash-medium"],
  ["high", -1, "gemini-3.8-flash-high"],
] as const) {
  const request = buildRequest(flash38Model, dummyContext, "test-proj", { reasoning }, runtime);
  assert.equal(request.request.generationConfig?.thinkingConfig?.thinkingBudget, thinkingBudget);
  assert.equal(request.request.generationConfig?.thinkingConfig?.includeThoughts, true);
}

const flash37Model = { ...model, id: "gemini-3.7-flash", maxTokens: 65536 };
const flash37 = buildRequest(flash37Model, dummyContext, "test-proj", { reasoning: "high" }, "gemini-3.7-flash-high");
assert.equal(flash37.request.generationConfig?.thinkingConfig?.thinkingBudget, -1);
assert.equal(flash37.request.generationConfig?.thinkingConfig?.includeThoughts, true);

const flash36 = buildRequest(
  { ...model, id: "gemini-3.6-flash", maxTokens: 65536 },
  dummyContext,
  "test-proj",
  { reasoning: "medium" },
  "gemini-3.6-flash-medium",
);
assert.equal(flash36.request.generationConfig?.thinkingConfig?.thinkingBudget, 4000);
assert.equal(flash36.request.generationConfig?.thinkingConfig?.includeThoughts, true);

const flash37Off = buildRequest(
  flash37Model,
  dummyContext,
  "test-proj",
  { reasoning: "off" },
  "gemini-3.7-flash-low",
);
assert.equal(flash37Off.request.generationConfig?.thinkingConfig?.includeThoughts, false);
assert.equal(flash37Off.request.generationConfig?.thinkingConfig?.thinkingBudget, 0);

const flash35 = buildRequest(
  { ...model, id: "gemini-3.5-flash", maxTokens: 65536 },
  dummyContext,
  "test-proj",
  { reasoning: "medium" },
  "gemini-3.5-flash-low",
);
assert.equal(flash35.request.generationConfig?.thinkingConfig?.thinkingBudget, 4000);
assert.match(flash35.requestId, /^agent\//);
assert.ok(flash35.request.labels?.trajectory_id);

const claudeReq = buildRequest(
  model,
  dummyContext,
  "test-proj",
  { reasoning: "high" },
  "claude-sonnet-4-6",
);
assert.equal(claudeReq.request.generationConfig?.thinkingConfig?.thinkingBudget, 1024);
assert.equal(claudeReq.request.generationConfig?.thinkingConfig?.includeThoughts, true);

const crossProviderOverride = buildRequest(
  flash37Model,
  dummyContext,
  "test-proj",
  { reasoning: "high" },
  "claude-sonnet-4-6",
);
assert.equal(
  crossProviderOverride.request.generationConfig?.thinkingConfig?.thinkingBudget,
  1024,
  "thinking configuration follows the effective runtime override",
);

const gptOssOverrideModel = { ...model, id: "gpt-oss-120b", maxTokens: 32768 };
const gptOssReq = buildRequest(
  gptOssOverrideModel,
  dummyContext,
  "test-proj",
  { reasoning: "medium" },
  "gpt-oss-120b-medium",
);
assert.equal(gptOssReq.request.generationConfig?.thinkingConfig?.thinkingBudget, 8192);
assert.equal(gptOssReq.request.generationConfig?.thinkingConfig?.includeThoughts, true);

const zeroUsage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const geminiRuntime = "gemini-3.7-flash-low";
const validSig = "QkFTRTY0LXRlc3Qtc2lnbmF0dXJlLXRlc3QxMjM0NTY=";

const multimodalResultContext = {
  messages: [
    { role: "user", content: "take screenshot", timestamp: Date.now() },
    {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "call-shot",
          name: "screenshot",
          arguments: {},
          thoughtSignature: validSig,
        },
      ],
      api: "antigravity-api",
      provider: "antigravity",
      model: "gemini-3.7-flash",
      usage: zeroUsage,
      stopReason: "toolUse",
      timestamp: Date.now(),
    },
    {
      role: "toolResult",
      toolCallId: "call-shot",
      toolName: "screenshot",
      content: [
        { type: "text", text: "captured" },
        { type: "image", data: "data:image/png;base64,iVBORw0KGgo=", mimeType: "image/png" },
      ],
      isError: false,
      timestamp: Date.now(),
    },
  ],
} as unknown as Context;
const convertedMultimodal = convertMessages(flash37Model, multimodalResultContext, geminiRuntime);
assert.equal(convertedMultimodal.length, 3);
assert.equal(convertedMultimodal[2]?.role, "user");
assert.equal(convertedMultimodal[2]?.parts.length, 2);
assert.ok(convertedMultimodal[2]?.parts.some((p) => "functionResponse" in p));
assert.ok(
  convertedMultimodal[2]?.parts.some((p) => "inlineData" in p && p.inlineData.mimeType === "image/png"),
);

const crossThinkingContext = {
  messages: [
    { role: "user", content: "hi", timestamp: Date.now() },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "cross model internal monologue" },
        { type: "text", text: "visible answer" },
      ],
      api: "anthropic-messages",
      provider: "anthropic",
      model: "claude-opus-4-6",
      usage: zeroUsage,
      stopReason: "stop",
      timestamp: Date.now(),
    },
  ],
} as unknown as Context;
const convertedCross = convertMessages(flash37Model, crossThinkingContext, geminiRuntime);
assert.equal(convertedCross[1]?.parts.length, 1);
assert.deepEqual(convertedCross[1]?.parts[0], { text: "visible answer" });

const unsignedToolContext = {
  messages: [
    { role: "user", content: "read file", timestamp: Date.now() },
    {
      role: "assistant",
      content: [
        { type: "toolCall", id: "call-prev-1", name: "read", arguments: { path: "main.ts" } },
      ],
      api: "openai-responses",
      provider: "openai",
      model: "gpt-4o",
      usage: zeroUsage,
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
const convertedUnsigned = convertMessages(flash37Model, unsignedToolContext, geminiRuntime);
assert.equal(convertedUnsigned.length, 1);
assert.equal(convertedUnsigned[0]?.role, "user");
assert.ok(
  convertedUnsigned[0]?.parts.some((p) => "text" in p && p.text.includes("Observation from `read`")),
);

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
        { type: "toolCall", id: "call-2", name: "read", arguments: { path: "b.ts" } },
      ],
      api: "antigravity-api",
      provider: "antigravity",
      model: "gemini-3.7-flash",
      usage: zeroUsage,
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
const convertedParallel = convertMessages(flash37Model, parallelSignedContext, geminiRuntime);
assert.equal(convertedParallel.length, 3);
assert.equal(convertedParallel[1]?.role, "model");
assert.equal(convertedParallel[1]?.parts.length, 2);
assert.ok(
  convertedParallel[1]?.parts.every((p) => "functionCall" in p),
  "all parallel calls in signed turn remain functionCalls",
);
assert.equal(convertedParallel[2]?.role, "user");
assert.equal(convertedParallel[2]?.parts.length, 2);
assert.ok(
  convertedParallel[2]?.parts.every((p) => "functionResponse" in p),
  "all parallel results remain functionResponses",
);

const abortedContext = {
  messages: [
    { role: "user", content: "hi", timestamp: Date.now() },
    {
      role: "assistant",
      content: [{ type: "text", text: "partial" }],
      api: "antigravity-api",
      provider: "antigravity",
      model: "gemini-3.7-flash",
      usage: zeroUsage,
      stopReason: "aborted",
      timestamp: Date.now(),
    },
  ],
} as unknown as Context;
const convertedAborted = convertMessages(flash37Model, abortedContext, geminiRuntime);
assert.equal(convertedAborted.length, 1);
assert.equal(convertedAborted[0]?.role, "user");

const withPiPrompt = buildRequest(
  flash37Model,
  { ...dummyContext, systemPrompt: "You are Pi. Follow AGENTS.md." },
  "test-proj",
  {},
  "gemini-3.7-flash-low",
);
assert.equal(withPiPrompt.request.systemInstruction.parts.length, 1);
assert.equal(withPiPrompt.request.systemInstruction.parts[0]?.text, "You are Pi. Follow AGENTS.md.");

// Skill-only turns are injected instructions, not user prompts. The request remains
// valid without inventing a user message, and the Skill is preserved as system context.
const skillOnlyContext = {
  messages: [
    {
      role: "user",
      content: '<skill name="smart-commit-grouping">Group commits by intent.</skill>',
      timestamp: Date.now(),
    },
  ],
} as Context;
const skillOnlyRequest = buildRequest(
  flash37Model,
  skillOnlyContext,
  "test-proj",
  {},
  "gemini-3.7-flash-low",
);
assert.equal(skillOnlyRequest.request.contents.length, 1);
assert.equal(skillOnlyRequest.request.contents[0]?.role, "user");
assert.equal(
  skillOnlyRequest.request.contents[0]?.parts[0]?.text,
  "Apply the active system instructions.",
);
assert.equal(skillOnlyRequest.request.systemInstruction.parts.length, 3);
assert.equal(
  skillOnlyRequest.request.systemInstruction.parts[2]?.text,
  '<skill name="smart-commit-grouping">Group commits by intent.</skill>',
);

const systemOnlyRequest = buildRequest(
  flash37Model,
  { messages: [], systemPrompt: "Follow the repository conventions." } as Context,
  "test-proj",
  {},
  "gemini-3.7-flash-low",
);
assert.equal(systemOnlyRequest.request.contents[0]?.parts[0]?.text, "Apply the active system instructions.");
assert.equal(
  systemOnlyRequest.request.systemInstruction.parts[0]?.text,
  "Follow the repository conventions.",
);

const skillAndUserContext = {
  messages: [
    {
      role: "user",
      content:
        '<skill name="smart-commit-grouping">Group commits by intent.</skill> Commit the staged changes.',
      timestamp: Date.now(),
    },
  ],
} as Context;
const skillAndUserRequest = buildRequest(
  flash37Model,
  skillAndUserContext,
  "test-proj",
  {},
  "gemini-3.7-flash-low",
);
assert.equal(skillAndUserRequest.request.contents[0]?.parts[0]?.text, " Commit the staged changes.");
assert.equal(
  skillAndUserRequest.request.systemInstruction.parts[2]?.text,
  '<skill name="smart-commit-grouping">Group commits by intent.</skill>',
);

// Tool-result-only turns also need no synthetic user text.
const toolResultOnlyContext = {
  messages: [
    {
      role: "toolResult",
      toolCallId: "call-1",
      toolName: "read",
      content: [{ type: "text", text: "file contents" }],
      isError: false,
      timestamp: Date.now(),
    },
  ],
} as unknown as Context;
const toolResultOnlyRequest = buildRequest(
  flash37Model,
  toolResultOnlyContext,
  "test-proj",
  {},
  "gemini-3.7-flash-low",
);
assert.equal(toolResultOnlyRequest.request.contents.length, 1);
assert.equal(toolResultOnlyRequest.request.contents[0]?.role, "user");
assert.ok(
  toolResultOnlyRequest.request.contents[0]?.parts.some((part) => "functionResponse" in part),
);
assert.ok(
  toolResultOnlyRequest.request.contents[0]?.parts.some(
    (part) => "text" in part && part.text === "Continue the active task using the available instructions and context.",
  ),
);

const fallbackPersona = buildRequest(flash37Model, dummyContext, "test-proj", {}, "gemini-3.7-flash-low");
assert.equal(fallbackPersona.request.systemInstruction.parts.length, 2);
assert.match(fallbackPersona.request.systemInstruction.parts[0]?.text || "", /You are Antigravity/);

const flashCost = ANTIGRAVITY_MODELS.find((m) => m.id === "gemini-3.7-flash")?.cost;
assert.equal(flashCost?.input, 0.1);
assert.equal(flashCost?.output, 0.4);
const opusCost = ANTIGRAVITY_MODELS.find((m) => m.id === "claude-opus-4-6")?.cost;
assert.equal(opusCost?.input, 15);
assert.equal(opusCost?.output, 75);

// Wire fingerprint: User-Agent format (pure agy CLI)
assert.equal(
  defaultUserAgent(),
  "antigravity/cli/1.1.23 (aidev_client; os_type=linux; arch=amd64; cl=974125021; auth_method=consumer)",
);

// Wire fingerprint: Headers hygiene & environment isolation
const savedUserAgent = process.env.ANTIGRAVITY_USER_AGENT;
const savedNoagyUserAgent = process.env.NOAGY_USER_AGENT;
try {
  delete process.env.ANTIGRAVITY_USER_AGENT;
  delete process.env.NOAGY_USER_AGENT;

  const defaultHeaders = antigravityHeaders("test-token-xyz");
  assert.equal(defaultHeaders.Authorization, "Bearer test-token-xyz");
  assert.equal(defaultHeaders["Content-Type"], "application/json");
  assert.equal(defaultHeaders["User-Agent"], defaultUserAgent());
  assert.equal(defaultHeaders["X-Goog-Api-Client"], undefined);
  assert.equal(defaultHeaders["Client-Metadata"], undefined);
  assert.equal(defaultHeaders["Accept"], undefined);

  // Wire fingerprint: Custom User-Agent override
  process.env.ANTIGRAVITY_USER_AGENT = "custom-agent/1.0";
  const overriddenHeaders = antigravityHeaders("test-token-xyz");
  assert.equal(overriddenHeaders["User-Agent"], "custom-agent/1.0");
} finally {
  if (savedUserAgent !== undefined) process.env.ANTIGRAVITY_USER_AGENT = savedUserAgent;
  else delete process.env.ANTIGRAVITY_USER_AGENT;
  if (savedNoagyUserAgent !== undefined) process.env.NOAGY_USER_AGENT = savedNoagyUserAgent;
  else delete process.env.NOAGY_USER_AGENT;
}
// Wire fingerprint: Envelope & labels normalization (PR 4)
// 1. antigravityRequestEnvelope backwards compatibility and options support
const envDefault = antigravityRequestEnvelope("gemini-3.7-flash-high", false);
assert.equal(envDefault.labels.last_step_index, "0");
assert.equal(envDefault.labels.request_id, `${envDefault.labels.trajectory_id}-0`);
assert.equal(envDefault.labels.used_claude, "false");
assert.equal(envDefault.labels.used_claude_conservative, "false");
assert.equal(envDefault.labels.used_non_gemini_model, "false");
assert.equal(envDefault.labels.model_enum, "MODEL_PLACEHOLDER_M298");
assert.match(envDefault.requestId, /^agent\/[0-9a-f-]+\/\d+\/[0-9a-f-]+\/1$/);

const envClaude = antigravityRequestEnvelope("claude-sonnet-4-6", true);
assert.equal(envClaude.labels.last_step_index, "0");
assert.equal(envClaude.labels.used_claude, "true");
assert.equal(envClaude.labels.used_claude_conservative, "true");
assert.equal(envClaude.labels.used_non_gemini_model, "true");
assert.equal(envClaude.labels.model_enum, "MODEL_PLACEHOLDER_M35");

const envMultiTurn = antigravityRequestEnvelope("gpt-oss-120b-medium", {
  isNonGemini: true,
  step: 3,
});
assert.equal(envMultiTurn.labels.last_step_index, "2");
assert.equal(envMultiTurn.labels.request_id, `${envMultiTurn.labels.trajectory_id}-2`);
assert.equal(envMultiTurn.labels.used_claude, "false");
assert.equal(envMultiTurn.labels.used_non_gemini_model, "true");
assert.equal(envMultiTurn.labels.model_enum, "MODEL_OPENAI_GPT_OSS_120B_MEDIUM");
assert.match(envMultiTurn.requestId, /^agent\/[0-9a-f-]+\/\d+\/[0-9a-f-]+\/3$/);

// 2. buildRequest wire labels across models
const claudeSonnetModel = ANTIGRAVITY_MODELS.find((m) => m.id === "claude-sonnet-4-6")!;
const claudeOpusModel = ANTIGRAVITY_MODELS.find((m) => m.id === "claude-opus-4-6")!;
const gptOssModel = ANTIGRAVITY_MODELS.find((m) => m.id === "gpt-oss-120b")!;
const pro31Model = ANTIGRAVITY_MODELS.find((m) => m.id === "gemini-3.1-pro")!;

const reqFlash38 = buildRequest(
  ANTIGRAVITY_MODELS.find((m) => m.id === "gemini-3.8-flash")!,
  dummyContext,
  "test-proj",
  {},
  "gemini-3.8-flash-high",
);
assert.equal(reqFlash38.request.labels?.last_step_index, "0");
assert.equal(reqFlash38.request.labels?.request_id, `${reqFlash38.request.labels?.trajectory_id}-0`);
assert.equal(reqFlash38.request.labels?.used_claude, "false");
assert.equal(reqFlash38.request.labels?.used_claude_conservative, "false");
assert.equal(reqFlash38.request.labels?.used_non_gemini_model, "false");
assert.equal(reqFlash38.request.labels?.model_enum, "MODEL_PLACEHOLDER_M318");
assert.match(reqFlash38.requestId, /\/1$/);

const reqFlash36 = buildRequest(
  ANTIGRAVITY_MODELS.find((m) => m.id === "gemini-3.6-flash")!,
  dummyContext,
  "test-proj",
  {},
  "gemini-3.6-flash-high",
);
assert.equal(reqFlash36.request.labels?.model_enum, "MODEL_PLACEHOLDER_M71");
assert.equal(reqFlash36.request.labels?.used_non_gemini_model, "false");

const reqPro = buildRequest(pro31Model, dummyContext, "test-proj", {}, "gemini-pro-agent");
assert.equal(reqPro.request.labels?.model_enum, "MODEL_PLACEHOLDER_M16");
assert.equal(reqPro.request.labels?.used_claude, "false");
assert.equal(reqPro.request.labels?.used_non_gemini_model, "false");

const reqSonnet = buildRequest(claudeSonnetModel, dummyContext, "test-proj", {}, "claude-sonnet-4-6");
assert.equal(reqSonnet.request.labels?.used_claude, "true");
assert.equal(reqSonnet.request.labels?.used_claude_conservative, "true");
assert.equal(reqSonnet.request.labels?.used_non_gemini_model, "true");
assert.equal(reqSonnet.request.labels?.model_enum, "MODEL_PLACEHOLDER_M35");

const reqOpus = buildRequest(claudeOpusModel, dummyContext, "test-proj", {}, "claude-opus-4-6-thinking");
assert.equal(reqOpus.request.labels?.used_claude, "true");
assert.equal(reqOpus.request.labels?.used_non_gemini_model, "true");
assert.equal(reqOpus.request.labels?.model_enum, "MODEL_PLACEHOLDER_M26");

const reqGptOss = buildRequest(gptOssModel, dummyContext, "test-proj", {}, "gpt-oss-120b-medium");
assert.equal(reqGptOss.request.labels?.used_claude, "false");
assert.equal(reqGptOss.request.labels?.used_claude_conservative, "false");
assert.equal(reqGptOss.request.labels?.used_non_gemini_model, "true");
assert.equal(reqGptOss.request.labels?.model_enum, "MODEL_OPENAI_GPT_OSS_120B_MEDIUM");

// 3. Multi-turn step calculation and tool call request_id sequence
const baseTime = 1700000000000;
const turn1Context: Context = {
  messages: [{ role: "user", content: "read file", timestamp: baseTime }],
};

// Turn 1, call 1: initial user prompt (0 prior assistant turns -> request_id: <traj>-0)
const reqTurn1 = buildRequest(flash37Model, turn1Context, "test-proj", {}, "gemini-3.7-flash-low");
assert.equal(reqTurn1.request.labels?.last_step_index, "0");
assert.equal(reqTurn1.request.labels?.request_id, `${reqTurn1.request.labels?.trajectory_id}-0`);
assert.match(reqTurn1.requestId, /\/1$/);

// Turn 1, call 2: tool execution result follows (1 assistant toolCall + 1 toolResult in context -> request_id: <traj>-1)
const turn1ToolContext: Context = {
  messages: [
    { role: "user", content: "read file", timestamp: baseTime },
    {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "call_1",
          name: "read_file",
          arguments: { path: "a.txt" },
          thoughtSignature: "dGVzdC1zaWduYXR1cmUtMTIzNDU2",
        },
      ],
      api: "antigravity-api",
      provider: "antigravity",
      model: "gemini-3.7-flash",
      usage: zeroUsage,
      stopReason: "stop",
      timestamp: baseTime + 1000,
    },
    {
      role: "toolResult",
      toolCallId: "call_1",
      toolName: "read_file",
      content: [{ type: "text", text: "file content" }],
      isError: false,
      timestamp: baseTime + 2000,
    },
  ],
};
const reqTurn1Tool = buildRequest(flash37Model, turn1ToolContext, "test-proj", {}, "gemini-3.7-flash-low");
assert.equal(reqTurn1Tool.request.labels?.last_step_index, "2");
assert.equal(reqTurn1Tool.request.labels?.request_id, `${reqTurn1Tool.request.labels?.trajectory_id}-1`);
assert.match(reqTurn1Tool.requestId, /\/3$/);
assert.equal(
  reqTurn1Tool.request.labels?.trajectory_id,
  reqTurn1.request.labels?.trajectory_id,
  "tool execution loop preserves same trajectory_id",
);

// Turn 2, call 3: user follow-up prompt (2 prior assistant turns -> request_id: <traj>-2)
const turn2Context: Context = {
  messages: [
    ...turn1ToolContext.messages,
    {
      role: "assistant",
      content: [{ type: "text", text: "done reading" }],
      api: "antigravity-api",
      provider: "antigravity",
      model: "gemini-3.7-flash",
      usage: zeroUsage,
      stopReason: "stop",
      timestamp: baseTime + 3000,
    },
    { role: "user", content: "summarize it", timestamp: baseTime + 4000 },
  ],
};
const reqTurn2 = buildRequest(flash37Model, turn2Context, "test-proj", {}, "gemini-3.7-flash-low");
assert.equal(reqTurn2.request.labels?.last_step_index, "4");
assert.equal(reqTurn2.request.labels?.request_id, `${reqTurn2.request.labels?.trajectory_id}-2`);
assert.match(reqTurn2.requestId, /\/5$/);
assert.equal(
  reqTurn2.request.labels?.trajectory_id,
  reqTurn1.request.labels?.trajectory_id,
  "turn 2 preserves same trajectory_id",
);

const failedAssistantContext: Context = {
  messages: [
    ...turn2Context.messages,
    {
      role: "assistant",
      content: [],
      api: "antigravity-api",
      provider: "antigravity",
      model: "gemini-3.7-flash",
      usage: zeroUsage,
      stopReason: "error",
      timestamp: baseTime + 5000,
    },
    {
      role: "assistant",
      content: [],
      api: "antigravity-api",
      provider: "antigravity",
      model: "gemini-3.7-flash",
      usage: zeroUsage,
      stopReason: "aborted",
      timestamp: baseTime + 6000,
    },
  ],
};
const reqAfterFailures = buildRequest(
  flash37Model,
  failedAssistantContext,
  "test-proj",
  {},
  "gemini-3.7-flash-low",
);
assert.equal(
  reqAfterFailures.request.labels?.request_id,
  `${reqAfterFailures.request.labels?.trajectory_id}-2`,
  "failed and aborted assistant messages do not increment requestIndex",
);

// 4. Session restart resilience: clearing in-memory cache restores identical deterministic trajectory_id
clearSessionTrajectoryMap();
const reqTurn2Restarted = buildRequest(flash37Model, turn2Context, "test-proj", {}, "gemini-3.7-flash-low");
assert.equal(
  reqTurn2Restarted.request.labels?.trajectory_id,
  reqTurn1.request.labels?.trajectory_id,
  "deterministic seed restores identical trajectory_id across process restarts",
);

// Wire fingerprint: toolConfig omission on default (auto) for all models (pure agy CLI)
const dummyToolsContext: Context = {
  ...dummyContext,
  tools: [
    {
      name: "read_file",
      description: "Read a file",
      parameters: { type: "object", properties: { path: { type: "string" } } },
    } as Tool,
  ],
};

// 1. Gemini with tools: tools present, toolConfig undefined
const geminiWithTools = buildRequest(
  flash37Model,
  dummyToolsContext,
  "test-proj",
  {},
  "gemini-3.7-flash-high",
);
assert.ok(geminiWithTools.request.tools);
assert.equal(geminiWithTools.request.toolConfig, undefined);

// 2. Claude with tools: tools present, toolConfig undefined
const claudeWithTools = buildRequest(
  model,
  dummyToolsContext,
  "test-proj",
  {},
  "claude-sonnet-4-6",
);
assert.ok(claudeWithTools.request.tools);
assert.equal(claudeWithTools.request.toolConfig, undefined);

// 3. Claude without tools: toolConfig undefined (no legacy VALIDATED injection)
const claudeNoTools = buildRequest(
  model,
  dummyContext,
  "test-proj",
  {},
  "claude-sonnet-4-6",
);
assert.equal(claudeNoTools.request.tools, undefined);
assert.equal(claudeNoTools.request.toolConfig, undefined);

// 4. GPT-OSS with tools: tools present, toolConfig undefined
const gptOssToolsModel = { ...model, id: "gpt-oss-120b", maxTokens: 32768 };
const gptOssWithTools = buildRequest(
  gptOssToolsModel,
  dummyToolsContext,
  "test-proj",
  {},
  "gpt-oss-120b-medium",
);
assert.ok(gptOssWithTools.request.tools);
assert.equal(gptOssWithTools.request.toolConfig, undefined);

// 5. Explicit toolChoice: "auto" -> toolConfig undefined
const autoReq = buildRequest(
  flash37Model,
  dummyToolsContext,
  "test-proj",
  { toolChoice: ToolChoice.Auto },
  "gemini-3.7-flash-high",
);
assert.equal(autoReq.request.toolConfig, undefined);

// 6. Explicit toolChoice: "none" -> toolConfig mode NONE
const noneReq = buildRequest(
  flash37Model,
  dummyToolsContext,
  "test-proj",
  { toolChoice: ToolChoice.None },
  "gemini-3.7-flash-high",
);
assert.deepEqual(noneReq.request.toolConfig, {
  functionCallingConfig: { mode: GeminiToolCallingMode.None },
});

// 7. Explicit toolChoice: "any" / "required" -> toolConfig mode ANY
const anyReq = buildRequest(
  flash37Model,
  dummyToolsContext,
  "test-proj",
  { toolChoice: ToolChoice.Any },
  "gemini-3.7-flash-high",
);
assert.deepEqual(anyReq.request.toolConfig, {
  functionCallingConfig: { mode: GeminiToolCallingMode.Any },
});

const reqChoice = buildRequest(
  flash37Model,
  dummyToolsContext,
  "test-proj",
  { toolChoice: ToolChoice.Required },
  "gemini-3.7-flash-high",
);
assert.deepEqual(reqChoice.request.toolConfig, {
  functionCallingConfig: { mode: GeminiToolCallingMode.Any },
});

// 8. String literals compatibility (Pi SimpleStreamOptions)
const stringAutoReq = buildRequest(
  flash37Model,
  dummyToolsContext,
  "test-proj",
  { toolChoice: "auto" },
  "gemini-3.7-flash-high",
);
assert.equal(stringAutoReq.request.toolConfig, undefined);

const stringNoneReq = buildRequest(
  flash37Model,
  dummyToolsContext,
  "test-proj",
  { toolChoice: "none" },
  "gemini-3.7-flash-high",
);
assert.deepEqual(stringNoneReq.request.toolConfig, {
  functionCallingConfig: { mode: GeminiToolCallingMode.None },
});

console.log(
  `model routing: ${routeCases.length} cases, tool schema, errors, project ids, token clamping, and message conversion passed`,
);
