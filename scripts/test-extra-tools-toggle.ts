import assert from "node:assert/strict";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import registerImage from "../src/features/generate-image.js";
import registerSearch from "../src/features/google-search.js";
import register from "../src/index.js";

const TOGGLES = ["NO_EXTRA_TOOLS", "NO_SEARCH_TOOL", "NO_IMAGE_TOOL", "DEFER_TOOLS"];

function withEnv<T>(env: Record<string, string>, run: () => T): T {
  const saved = new Map<string, string | undefined>();
  for (const name of TOGGLES) {
    for (const key of [`ANTIGRAVITY_${name}`, `NOAGY_${name}`]) {
      saved.set(key, process.env[key]);
      delete process.env[key];
    }
  }
  Object.assign(process.env, env);
  try {
    return run();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function registeredTools(env: Record<string, string>): { tools: string[]; commands: string[] } {
  const tools: string[] = [];
  const commands: string[] = [];
  const pi = new Proxy(
    {},
    {
      get(_target, prop) {
        if (prop === "registerTool") return (tool: { name: string }) => tools.push(tool.name);
        if (prop === "registerCommand") return (name: string) => commands.push(name);
        return () => undefined;
      },
    },
  );
  withEnv(env, () => {
    const api = pi as Parameters<typeof register>[0];
    register(api);
    registerSearch(api);
    registerImage(api);
  });
  return { tools: tools.sort(), commands };
}

type ToolDefinition = {
  name: string;
  exposure?: string;
};

function featureDefinitions(env: Record<string, string>): ToolDefinition[] {
  const definitions: ToolDefinition[] = [];
  const pi = new Proxy(
    {},
    {
      get(_target, prop) {
        if (prop === "registerTool") {
          return (tool: ToolDefinition) => definitions.push(tool);
        }
        throw new Error(`Unexpected feature API: ${String(prop)}`);
      },
    },
  );
  withEnv(env, () => {
    registerSearch(pi as ExtensionAPI);
    registerImage(pi as ExtensionAPI);
  });
  return definitions;
}

const both = ["generate_image", "google_search"];
assert.deepEqual(registeredTools({}).tools, both, "both tools are registered by default");
assert.deepEqual(registeredTools({ ANTIGRAVITY_NO_EXTRA_TOOLS: "1" }).tools, [], "umbrella toggle");
assert.deepEqual(
  registeredTools({ ANTIGRAVITY_NO_SEARCH_TOOL: "1" }).tools,
  ["generate_image"],
  "search toggle keeps image tool",
);
assert.deepEqual(
  registeredTools({ ANTIGRAVITY_NO_IMAGE_TOOL: "1" }).tools,
  ["google_search"],
  "image toggle keeps search tool",
);
assert.deepEqual(
  registeredTools({ NOAGY_NO_SEARCH_TOOL: "1" }).tools,
  ["generate_image"],
  "legacy NOAGY_ prefix is honoured",
);
assert.deepEqual(registeredTools({ ANTIGRAVITY_NO_SEARCH_TOOL: "0" }).tools, both, "only 1 disables");

// Slash commands are explicit user actions and stay available when the tools are off.
const { commands } = registeredTools({ ANTIGRAVITY_NO_EXTRA_TOOLS: "1" });
assert.ok(commands.includes("antigravity.search") && commands.includes("antigravity.image"));

for (const env of [{}, { ANTIGRAVITY_DEFER_TOOLS: "0" }]) {
  const definitions = featureDefinitions(env);
  assert.equal(definitions.length, 2);
  assert.ok(definitions.every((tool) => !("exposure" in tool)));
}

for (const env of [
  { ANTIGRAVITY_DEFER_TOOLS: "1" },
  { NOAGY_DEFER_TOOLS: "1" },
]) {
  const definitions = featureDefinitions(env);
  assert.deepEqual(
    definitions.map((tool) => ({ name: tool.name, exposure: tool.exposure })),
    [
      { name: "google_search", exposure: "deferred" },
      { name: "generate_image", exposure: "deferred" },
    ],
  );
}

for (const [toggle, expectedNames] of [
  ["NO_SEARCH_TOOL", ["generate_image"]],
  ["NO_IMAGE_TOOL", ["google_search"]],
] as const) {
  const definitions = featureDefinitions({
    ANTIGRAVITY_DEFER_TOOLS: "1",
    [`ANTIGRAVITY_${toggle}`]: "1",
  });
  assert.deepEqual(definitions.map((tool) => tool.name), expectedNames);
}

console.log("extra tools toggle: disables, deferred exposure passed");
