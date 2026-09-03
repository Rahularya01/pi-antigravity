import type { Api, Context, Model, Tool } from "@earendil-works/pi-ai";
import { defaultProjectId, stableProjectId } from "../src/client/index.js";
import { getLastDiagnostics, resetDiagnosticsForTests } from "../src/diagnostics/index.js";
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

// Case E: Gemini 3.8/3.7/3.6 send thinkingLevel; 3.5 sends thinkingBudget.
const flash38Model = { ...model, id: "gemini-3.8-flash", maxTokens: 65536 };
for (const [reasoning, thinkingLevel, runtime] of [
  ["low", "LOW", "gemini-3.8-flash-low"],
  ["medium", "MEDIUM", "gemini-3.8-flash-medium"],
  ["high", "HIGH", "gemini-3.8-flash-high"],
] as const) {
  const request = buildRequest(flash38Model, dummyContext, "test-proj", { reasoning }, runtime);
  assert.equal(request.request.generationConfig?.thinkingConfig?.thinkingLevel, thinkingLevel);
  assert.equal(request.request.generationConfig?.thinkingConfig?.includeThoughts, true);
}

const flash37Model = { ...model, id: "gemini-3.7-flash", maxTokens: 65536 };
const flash37 = buildRequest(flash37Model, dummyContext, "test-proj", { reasoning: "high" }, "gemini-3.7-flash-high");
assert.equal(flash37.request.generationConfig?.thinkingConfig?.thinkingLevel, "HIGH");

const flash36 = buildRequest(
  { ...model, id: "gemini-3.6-flash", maxTokens: 65536 },
  dummyContext,
  "test-proj",
  { reasoning: "medium" },
  "gemini-3.6-flash-medium",
);
assert.equal(flash36.request.generationConfig?.thinkingConfig?.thinkingLevel, "MEDIUM");

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

const fallbackPersona = buildRequest(flash37Model, dummyContext, "test-proj", {}, "gemini-3.7-flash-low");
assert.equal(fallbackPersona.request.systemInstruction.parts.length, 2);
assert.match(fallbackPersona.request.systemInstruction.parts[0]?.text || "", /You are Antigravity/);

const flashCost = ANTIGRAVITY_MODELS.find((m) => m.id === "gemini-3.7-flash")?.cost;
assert.equal(flashCost?.input, 0.1);
assert.equal(flashCost?.output, 0.4);
const opusCost = ANTIGRAVITY_MODELS.find((m) => m.id === "claude-opus-4-6")?.cost;
assert.equal(opusCost?.input, 15);
assert.equal(opusCost?.output, 75);

console.log(
  `model routing: ${routeCases.length} cases, tool schema, errors, project ids, token clamping, and message conversion passed`,
);
