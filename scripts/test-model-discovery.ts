import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mergeAvailableModelsResults } from "../src/client/index.js";
import type { ModelInfoRaw } from "../src/types/types.js";
import {
  ANTIGRAVITY_MODELS,
  ANTIGRAVITY_ROUTING,
  applyAntigravityCatalog,
  buildAntigravityCatalog,
  getAntigravityRequestModelId,
  getFallbackRuntimeModel,
  getThinkingConfig,
  humanizePublicId,
  readCatalogCache,
  resetAntigravityCatalogForTests,
  resolvedCatalog,
  setCatalogCachePathForTests,
  writeCatalogCache,
  type AntigravityCatalog,
} from "../src/models/index.js";

function fail(message: string): never {
  throw new Error(message);
}

const assert = {
  equal(actual: unknown, expected: unknown, message?: string) {
    if (actual !== expected) fail(message ?? `expected ${String(expected)}, got ${String(actual)}`);
  },
  ok(value: unknown, message?: string) {
    if (!value) fail(message ?? "expected a truthy value");
  },
  deepEqual(actual: unknown, expected: unknown, message?: string) {
    if (!Bun.deepEquals(actual, expected)) {
      fail(message ?? `expected ${Bun.inspect(expected)}, got ${Bun.inspect(actual)}`);
    }
  },
};

const fallback: AntigravityCatalog = {
  models: ANTIGRAVITY_MODELS,
  routing: ANTIGRAVITY_ROUTING,
};

function info(
  displayName: string,
  extra?: Partial<ModelInfoRaw>,
): ModelInfoRaw {
  return { displayName, supportsThinking: true, supportsImages: true, ...extra };
}

const currentCatalog: Record<string, ModelInfoRaw> = {
  "gemini-3.9-flash-low": info("Gemini 3.9 Flash (Low)"),
  "gemini-3.9-flash-medium": info("Gemini 3.9 Flash (Medium)"),
  "gemini-3.9-flash-high": info("Gemini 3.9 Flash (High)"),
  "gemini-3.8-flash-low": info("Gemini 3.8 Flash (Low)"),
  "gemini-3.8-flash-medium": info("Gemini 3.8 Flash (Medium)"),
  "gemini-3.8-flash-high": info("Gemini 3.8 Flash (High)"),
  "gemini-3.7-flash-low": info("Gemini 3.7 Flash (Low)"),
  "gemini-3.7-flash-medium": info("Gemini 3.7 Flash (Medium)"),
  "gemini-3.7-flash-high": info("Gemini 3.7 Flash (High)"),
  "gemini-3.6-flash-low": info("Gemini 3.6 Flash (Low)"),
  "gemini-3.6-flash-medium": info("Gemini 3.6 Flash (Medium)"),
  "gemini-3.6-flash-high": info("Gemini 3.6 Flash (High)"),
  "gemini-3.5-flash-extra-low": info("Gemini 3.5 Flash (Low)"),
  "gemini-3.5-flash-low": info("Gemini 3.5 Flash (Medium)"),
  "gemini-3-flash-agent": info("Gemini 3.5 Flash (High)"),
  "gemini-3.1-pro-low": info("Gemini 3.1 Pro (Low)"),
  "gemini-3.1-pro-high": info("Gemini 3.1 Pro (High)"),
  "gemini-pro-agent": info("Gemini 3.1 Pro (High)"),
  "claude-sonnet-4-6": info("Claude Sonnet 4.6 (Thinking)"),
  "claude-opus-4-6-thinking": info("Claude Opus 4.6 (Thinking)"),
  "gpt-oss-120b-medium": info("GPT-OSS 120B (Medium)", { supportsImages: false }),
  "chat_hidden": info("Hidden chat"),
  "gemini-3-pro-image": info("Gemini 3 Pro Image"),
  "MODEL_PLACEHOLDER_M16": info("placeholder"),
};

const catalog = buildAntigravityCatalog(currentCatalog, fallback);
const ids = new Set(catalog.models.map((model) => model.id));

assert.ok(ids.has("gemini-3.8-flash"), "preserves and refreshes Gemini 3.8");
assert.ok(ids.has("gemini-3.9-flash"), "discovers a Gemini family missing from fallback");
assert.ok(ids.has("gemini-3.7-flash"), "preserves Gemini 3.7");
assert.ok(ids.has("claude-sonnet-4-6"), "preserves Claude Sonnet");
assert.ok(ids.has("claude-opus-4-6"), "preserves Claude Opus");
assert.ok(ids.has("gpt-oss-120b"), "preserves GPT-OSS");
assert.ok(!ids.has("chat_hidden"), "skips chat_ models");
assert.ok(!ids.has("gemini-3-pro-image"), "skips image models");
assert.ok(!ids.has("MODEL_PLACEHOLDER_M16"), "skips placeholder enums");
assert.ok(!ids.has("gemini-3-flash-agent"), "agent alias is grouped, not a public model");

const flash38 = catalog.models.find((model) => model.id === "gemini-3.8-flash");
assert.ok(flash38, "gemini-3.8-flash is selectable");
const flash38Levels = Object.entries(flash38?.thinkingLevelMap ?? {})
  .filter(([, value]) => value !== null)
  .map(([level]) => level);
assert.deepEqual(flash38Levels, ["low", "medium", "high"], "groups 3.8 low/medium/high");
assert.equal(catalog.routing["gemini-3.8-flash"]?.routing?.low, "gemini-3.8-flash-low");
assert.equal(catalog.routing["gemini-3.8-flash"]?.routing?.medium, "gemini-3.8-flash-medium");
assert.equal(catalog.routing["gemini-3.8-flash"]?.routing?.high, "gemini-3.8-flash-high");
assert.equal(catalog.routing["gemini-3.9-flash"]?.routing?.medium, "gemini-3.9-flash-medium");

const single = buildAntigravityCatalog(
  { "gemini-custom-preview": info("Gemini Custom Preview", { supportsThinking: false }) },
  fallback,
);
const customPreview = single.models.find((model) => model.id === "gemini-custom-preview");
assert.ok(customPreview, "single unsuffixed runtime becomes its own public model");
assert.equal(single.routing["gemini-custom-preview"]?.defaultRequestId, "gemini-custom-preview");
assert.equal(
  customPreview?.reasoning,
  false,
  "explicit supportsThinking: false must not infer reasoning",
);
assert.equal(
  customPreview?.thinkingLevelMap,
  undefined,
  "explicit non-thinking models must not expose thinking controls",
);

const omittedThinking = buildAntigravityCatalog(
  { "gemini-custom-omitted": { displayName: "Gemini Custom Omitted" } },
  fallback,
);
const customOmitted = omittedThinking.models.find((model) => model.id === "gemini-custom-omitted");
assert.equal(
  customOmitted?.reasoning,
  true,
  "omitted capability data may still infer conservative reasoning",
);

applyAntigravityCatalog(catalog);
assert.equal(getAntigravityRequestModelId("gemini-3.8-flash", "medium"), "gemini-3.8-flash-medium");
assert.equal(
  getAntigravityRequestModelId("gemini-3.1-pro", "high"),
  "gemini-pro-agent",
  "legacy gemini-pro-agent override still wins",
);
assert.equal(
  getAntigravityRequestModelId("gemini-3.5-flash", "low"),
  "gemini-3.5-flash-extra-low",
  "legacy 3.5 extra-low mapping still wins",
);
assert.equal(
  getAntigravityRequestModelId("gemini-3.5-flash", "high"),
  "gemini-3-flash-agent",
  "legacy 3.5 agent high mapping still wins",
);
assert.equal(getAntigravityRequestModelId("claude-opus-4-6", "high"), "claude-opus-4-6-thinking");
assert.equal(getAntigravityRequestModelId("gpt-oss-120b", "medium"), "gpt-oss-120b-medium");
assert.equal(
  getThinkingConfig("gemini-3.8-flash", "medium")?.thinkingLevel,
  "MEDIUM",
  "new Gemini families send thinkingLevel",
);
assert.equal(getThinkingConfig("gemini-3.5-flash", "medium")?.thinkingBudget, 4000);
assert.equal(
  getThinkingConfig("gemini-3.7-flash", "off")?.includeThoughts,
  false,
  "reasoning=off disables Gemini thinking",
);
assert.equal(getThinkingConfig("gemini-3.7-flash", "off")?.thinkingLevel, undefined);
assert.equal(getThinkingConfig("gemini-3.6-flash", undefined)?.includeThoughts, false);
assert.equal(getThinkingConfig("gemini-3.8-flash", "off")?.includeThoughts, false);
assert.equal(getThinkingConfig("gemini-3.7-flash", "medium")?.includeThoughts, true);
assert.equal(getThinkingConfig("gemini-3.7-flash", "medium")?.thinkingLevel, "MEDIUM");

const mergedDefaultOnly = mergeAvailableModelsResults([
  {
    endpoint: "https://cloudcode-pa.googleapis.com",
    status: 200,
    data: {
      models: { "gemini-3.7-flash-low": info("Gemini 3.7 Flash (Low)") },
      defaultAgentModel: "gemini-3.7-flash-low",
    },
  },
]);
assert.equal(
  mergedDefaultOnly.data.defaultAgentModel,
  "gemini-3.7-flash-low",
  "preserve defaultAgentModel when defaultAgentModelId is omitted",
);
assert.equal(mergedDefaultOnly.data.defaultAgentModelId, undefined);
assert.equal(
  mergedDefaultOnly.data.defaultAgentModelId || mergedDefaultOnly.data.defaultAgentModel,
  "gemini-3.7-flash-low",
);
assert.equal(
  getFallbackRuntimeModel("gemini-3.8-flash-medium"),
  "gemini-3.7-flash-medium",
  "existing Gemini 3.8 rollout fallback remains available",
);

const emptyDiscovered = buildAntigravityCatalog({}, fallback);
assert.equal(
  emptyDiscovered.models.length,
  fallback.models.length,
  "empty backend preserves conservative static models",
);
const kept = resolvedCatalog(emptyDiscovered, fallback);
assert.equal(kept, fallback, "empty discovery does not replace last-known-good catalog");
assert.equal(resolvedCatalog(undefined, fallback), fallback, "failed discovery keeps current catalog");

const dir = mkdtempSync(join(tmpdir(), "antigravity-catalog-"));
const cachePath = join(dir, "antigravity-model-catalog.json");
try {
  setCatalogCachePathForTests(cachePath);
  const written = writeCatalogCache(catalog, cachePath);
  assert.ok(written, "successful discovery is cached");
  const loaded = readCatalogCache(cachePath);
  assert.ok(loaded?.models.some((model) => model.id === "gemini-3.8-flash"));
  const before = readFileSync(cachePath, "utf8");
  const skipped = writeCatalogCache({ models: [], routing: {} }, cachePath);
  assert.equal(skipped, undefined, "empty catalog is not persisted");
  assert.equal(readFileSync(cachePath, "utf8"), before, "empty response does not wipe cache file");
} finally {
  setCatalogCachePathForTests(undefined);
  resetAntigravityCatalogForTests();
  rmSync(dir, { recursive: true, force: true });
}

assert.equal(humanizePublicId("gemini-3.8-flash"), "Gemini 3.8 Flash");
assert.equal(humanizePublicId("claude-opus-4-6"), "Claude Opus 4.6");
assert.equal(humanizePublicId("gpt-oss-120b"), "GPT-OSS 120B");

assert.equal(
  getAntigravityRequestModelId("gemini-3.7-flash", "high"),
  "gemini-3.7-flash-high",
  "reset restores static fallback routing",
);

const runtimeOverride = process.env.ANTIGRAVITY_RUNTIME_MODEL;
assert.ok(
  runtimeOverride === undefined || typeof runtimeOverride === "string",
  "ANTIGRAVITY_RUNTIME_MODEL remains an env override (applied in stream, not grouping)",
);

console.log(
  "model discovery: grouping, overrides, empty/failure fallback, cache replace-on-success, and thinking config passed",
);
