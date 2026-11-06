/**
 * Live catalog probe (requires local credentials; never part of npm test).
 *   node scripts/run-ts.mjs scripts/probe-model-discovery.mjs
 * Add --generate for small Gemini/Claude requests that consume quota.
 * Does not refresh or persist credentials, or print raw API responses.
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { authPath, readJson } from "./fs-json.mjs";
import { antigravityHeaders, endpointCandidates } from "../src/client/index.js";
import {
  ANTIGRAVITY_MODELS,
  ANTIGRAVITY_ROUTING,
  buildAntigravityCatalog,
} from "../src/models/index.js";

const args = new Set(process.argv.slice(2));
for (const arg of args) {
  if (arg !== "--generate") throw new Error("Unknown option: " + arg);
}
const fallback = { models: ANTIGRAVITY_MODELS, routing: ANTIGRAVITY_ROUTING };

let passed = 0;
let failed = 0;
async function check(name, fn) {
  try {
    await fn();
    console.log("PASS " + name);
    passed++;
  } catch (error) {
    // Only locally constructed assertions are reported, never API bodies.
    console.log(
      "FAIL " +
        name +
        ": " +
        (error instanceof assert.AssertionError ? error.message.split("\n")[0] : error.name),
    );
    failed++;
  }
}
// Explicit auth file takes precedence; malformed account files must not silently
// switch to another identity. This probe does not refresh or persist credentials.
const accountsPath =
  process.env.PI_ANTIGRAVITY_ACCOUNTS_PATH ||
  join(homedir(), ".pi", "agent", "antigravity-accounts.json");
let creds;
if (!process.env.PI_AUTH_PATH && existsSync(accountsPath)) {
  const data = readJson(accountsPath);
  creds = data.accounts?.[data.activeAccountId];
} else {
  creds = readJson(authPath()).antigravity;
}
assert.ok(
  creds?.access && creds?.projectId,
  "Login first: active access token and project required",
);
assert.ok(
  !creds.expires || creds.expires > Date.now(),
  "Token expired; log in again before probing",
);

for (const endpoint of endpointCandidates()) {
  let raw;
  let agentModelSorts;
  await check(endpoint + " catalog response", async () => {
    const res = await fetch(endpoint + "/v1internal:fetchAvailableModels", {
      method: "POST",
      headers: antigravityHeaders(creds.access),
      body: JSON.stringify({ project: creds.projectId }),
      signal: AbortSignal.timeout(20000),
    });
    assert.equal(res.status, 200, "catalog HTTP " + res.status);
    const data = await res.json();
    assert.ok(
      data.models && typeof data.models === "object" && !Array.isArray(data.models),
      "unrecognized catalog schema",
    );
    assert.ok(Object.keys(data.models).length, "empty catalog");
    raw = data.models;
    agentModelSorts = data.agentModelSorts;
  });
  if (!raw) continue;
  let catalog;
  await check(endpoint + " supported chat catalog", () => {
    catalog = buildAntigravityCatalog(raw, fallback, agentModelSorts);
  });
  if (!catalog) continue;
  console.log(
    "INFO " +
      endpoint +
      ": " +
      Object.keys(raw).length +
      " advertised runtime IDs; " +
      catalog.models.length +
      " public models",
  );
  console.log("INFO selectable: " + catalog.models.map((model) => model.id).join(", "));
  await check(endpoint + " every generated route exists in live response", () => {
    for (const r of Object.values(catalog.routing)) {
      for (const id of [r.off, r.defaultRequestId, ...Object.values(r.routing || {})]) {
        if (id) assert.ok(Object.hasOwn(raw, id), "absent runtime: " + id);
      }
    }
  });
  await check(endpoint + " public metadata matches advertised limits", () => {
    for (const m of catalog.models) {
      const route = catalog.routing[m.id];
      const ids = new Set([
        route.defaultRequestId,
        route.off,
        ...Object.values(route.routing || {}),
      ]);
      const infos = [...ids].map((id) => raw[id]).filter(Boolean);
      for (const [field, publicField] of [
        ["maxTokens", "contextWindow"],
        ["maxOutputTokens", "maxTokens"],
      ]) {
        const limits = infos
          .map((info) => info[field])
          .filter((n) => Number.isSafeInteger(n) && n > 0);
        if (limits.length)
          assert.equal(m[publicField], Math.min(...limits), field + " mismatch: " + m.id);
      }
    }
  });
  if (!args.has("--generate")) continue;
  for (const family of ["gemini-", "claude-"]) {
    const model = catalog.models.find(
      (m) => m.id.startsWith(family) && Object.hasOwn(raw, catalog.routing[m.id]?.defaultRequestId),
    );
    if (!model) {
      console.log("SKIP no advertised " + family + " model");
      continue;
    }
    const id = catalog.routing[model.id].defaultRequestId;
    await check(endpoint + " generation " + id, async () => {
      const res = await fetch(endpoint + "/v1internal:streamGenerateContent?alt=sse", {
        method: "POST",
        headers: antigravityHeaders(creds.access),
        body: JSON.stringify({
          project: creds.projectId,
          model: id,
          requestType: "agent",
          request: {
            contents: [{ role: "user", parts: [{ text: "Reply with exactly: CATALOG_OK" }] }],
            generationConfig: { maxOutputTokens: 1024 },
          },
        }),
        signal: AbortSignal.timeout(60000),
      });
      assert.equal(res.status, 200, "generation HTTP " + res.status);
      let answer = "";
      let events = 0;
      for (const line of (await res.text()).split("\n")) {
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        const chunk = JSON.parse(payload);
        assert.ok(!chunk.error && !chunk.response?.error, "stream contained an error");
        events++;
        for (const part of chunk.response?.candidates?.[0]?.content?.parts || [])
          if (part.text && !part.thought) answer += part.text;
      }
      assert.ok(events > 0, "no SSE events");
      assert.equal(answer.trim(), "CATALOG_OK", "generation did not return expected marker");
    });
  }
}
console.log("\nLive discovery probe: " + passed + " passed, " + failed + " failed");
process.exitCode = failed ? 1 : 0;
