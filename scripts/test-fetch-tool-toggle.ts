import assert from "node:assert/strict";
import registerFetch from "../src/features/read-url-content.js";

const TOGGLES = ["NO_EXTRA_TOOLS", "NO_FETCH_TOOL"];

function fetchToolRegistered(env: Record<string, string>): boolean {
  const saved = new Map<string, string | undefined>();
  for (const name of TOGGLES) {
    for (const key of [`ANTIGRAVITY_${name}`, `NOAGY_${name}`]) {
      saved.set(key, process.env[key]);
      delete process.env[key];
    }
  }
  Object.assign(process.env, env);
  const tools: string[] = [];
  try {
    registerFetch({ registerTool: (tool: { name: string }) => tools.push(tool.name) } as never);
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  return tools.includes("read_url_content");
}

assert.equal(fetchToolRegistered({}), true, "registered by default");
assert.equal(fetchToolRegistered({ ANTIGRAVITY_NO_EXTRA_TOOLS: "1" }), false, "umbrella toggle");
assert.equal(fetchToolRegistered({ ANTIGRAVITY_NO_FETCH_TOOL: "1" }), false, "fetch toggle");
assert.equal(fetchToolRegistered({ NOAGY_NO_FETCH_TOOL: "1" }), false, "legacy prefix");
assert.equal(fetchToolRegistered({ ANTIGRAVITY_NO_FETCH_TOOL: "0" }), true, "only 1 disables");

console.log("fetch tool toggle: default, umbrella, fetch, legacy prefix passed");
