import assert from "node:assert/strict";
import type { Tool } from "@earendil-works/pi-ai";
import { convertTools } from "../src/stream.js";
import { ANTIGRAVITY_MODELS, getAntigravityRequestModelId } from "../src/models.js";

const route = (model: string, effort?: string) => getAntigravityRequestModelId(model, effort);

const routeCases: Array<[string, string | undefined, string]> = [
  ["gemini-3.5-flash", undefined, "gemini-3.5-flash-extra-low"],
  ["gemini-3.5-flash", "off", "gemini-3.5-flash-extra-low"],
  ["gemini-3.5-flash", "minimal", "gemini-3.5-flash-extra-low"],
  ["gemini-3.5-flash", "low", "gemini-3.5-flash-low"],
  ["gemini-3.5-flash", "medium", "gemini-3.5-flash-low"],
  ["gemini-3.5-flash", "high", "gemini-3-flash-agent"],
  ["gemini-3.5-flash", "xhigh", "gemini-3-flash-agent"],
  ["gemini-3.1-pro", "medium", "gemini-3.1-pro-low"],
  ["gemini-3.1-pro", "high", "gemini-3.1-pro-high"],
  ["gemini-3.1-pro", "xhigh", "gemini-3.1-pro-high"],
  ["claude-sonnet-4-6", "xhigh", "claude-sonnet-4-6"],
  ["claude-opus-4-6", "high", "claude-opus-4-6-thinking"],
  ["gpt-oss-120b", "high", "gpt-oss-120b-medium"],
  ["unknown-model", "high", "unknown-model"],
];

for (const [model, effort, expected] of routeCases) {
  assert.equal(route(model, effort), expected, `${model} (${effort ?? "default"})`);
}

const modelIds = new Set(ANTIGRAVITY_MODELS.map((model) => model.id));
for (const expected of [
  "gemini-3.5-flash",
  "gemini-3.1-pro",
  "claude-sonnet-4-6",
  "claude-opus-4-6",
  "gpt-oss-120b",
]) {
  assert.ok(modelIds.has(expected), `missing selectable model: ${expected}`);
}

const booleanUnionTool = {
  name: "boolean_union",
  description: "Exercises Pi's boolean enum schema shape.",
  parameters: {
    type: "object",
    properties: {
      value: {
        anyOf: [{ type: "string", enum: ["auto"] }, { type: "boolean", enum: [false] }],
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

console.log(`model routing: ${routeCases.length} cases and tool schema conversion passed`);
