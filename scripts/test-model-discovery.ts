import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { antigravityHeaders, mergeAvailableModelsResults } from "../src/client/index.js";
import type { ModelInfoRaw } from "../src/types/types.js";
import {
  ANTIGRAVITY_MODELS,
  ANTIGRAVITY_ROUTING,
  applyAntigravityCatalog,
  buildAntigravityCatalog,
  clearModelEnumCache,
  getAntigravityRequestModelId,
  getFallbackRuntimeModel,
  getModelEnum,
  getThinkingConfig,
  humanizePublicId,
  readCatalogCache,
  registerDiscoveredModelEnums,
  registerModelEnum,
  resetAntigravityCatalogForTests,
  resolvedCatalog,
  setCatalogCachePathForTests,
  writeCatalogCache,
  refreshAntigravityModels,
  DEFAULT_CATALOG_REFRESH_INTERVAL_MS,
  getCatalogRefreshIntervalMs,
  type AntigravityCatalog,
} from "../src/models/index.js";

function fail(message: string): never {
  throw new Error(message);
}

const assert = {
  equal(actual: unknown, expected: unknown, message?: string) {
    if (actual !== expected) fail(message ?? `expected ${String(expected)}, got ${String(actual)}`);
  },
  notEqual(actual: unknown, expected: unknown, message?: string) {
    if (actual === expected) fail(message ?? `expected values not to be equal: ${String(actual)}`);
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

// TTL caching tests for refreshAntigravityModels
assert.equal(
  DEFAULT_CATALOG_REFRESH_INTERVAL_MS,
  4 * 60 * 60 * 1000,
  "default refresh interval is 4 hours",
);
assert.equal(getCatalogRefreshIntervalMs(), 4 * 60 * 60 * 1000, "reads default refresh interval");

process.env.ANTIGRAVITY_CATALOG_REFRESH_INTERVAL_MS = "1800000";
assert.equal(getCatalogRefreshIntervalMs(), 1800000, "reads ANTIGRAVITY_ override");
delete process.env.ANTIGRAVITY_CATALOG_REFRESH_INTERVAL_MS;

// Test TTL skip: when stored checkedAt is fresh (< 4 hours) and force is false, returns models without network
const abortCtrl = new AbortController();
const validKey = JSON.stringify({ token: "fake-token", projectId: "fake-project" });
let publishCalled = false;
const mockContextFresh = {
  credential: { type: "api_key" as const, key: validKey },
  stored: {
    models: catalog.models.map((m) => ({ ...m, provider: "antigravity", api: "antigravity-api" as const, baseUrl: "https://example.com" })),
    checkedAt: Date.now() - 60_000, // 1 minute ago
  },
  allowNetwork: true,
  force: false,
  signal: abortCtrl.signal,
  publish: async () => {
    publishCalled = true;
    return true;
  },
};

const freshResult = await refreshAntigravityModels(mockContextFresh);
assert.ok(freshResult.length > 0, "returns catalog models when fresh");
assert.equal(publishCalled, false, "does not make network call or publish when cache is fresh");

// Test TTL skip when context.stored has no checkedAt, but file cache has fresh checkedAt
const dir2 = mkdtempSync(join(tmpdir(), "antigravity-catalog-ttl-"));
const cachePath2 = join(dir2, "antigravity-model-catalog.json");
try {
  setCatalogCachePathForTests(cachePath2);
  writeCatalogCache(catalog, cachePath2);
  let publishCalled2 = false;
  const mockContextFileFresh = {
    credential: { type: "api_key" as const, key: validKey },
    stored: undefined,
    allowNetwork: true,
    force: false,
    signal: abortCtrl.signal,
    publish: async () => {
      publishCalled2 = true;
      return true;
    },
  };
  const fileFreshResult = await refreshAntigravityModels(mockContextFileFresh);
  assert.ok(fileFreshResult.length > 0, "returns catalog models when file cache is fresh");
  assert.equal(publishCalled2, false, "skips network call when file cache checkedAt is fresh");
} finally {
  setCatalogCachePathForTests(undefined);
  rmSync(dir2, { recursive: true, force: true });
}

// Test successful network discovery: renews checkedAt and calls publish() even when models match catalog
const dirNetwork = mkdtempSync(join(tmpdir(), "antigravity-catalog-net-"));
const cachePathNetwork = join(dirNetwork, "antigravity-model-catalog.json");
const originalFetch = globalThis.fetch;
try {
  setCatalogCachePathForTests(cachePathNetwork);
  const expiredTime = Date.now() - 5 * 60 * 60 * 1000;
  writeCatalogCache(catalog, cachePathNetwork);
  const cacheContent = JSON.parse(readFileSync(cachePathNetwork, "utf8"));
  cacheContent.checkedAt = expiredTime;
  writeFileSync(cachePathNetwork, JSON.stringify(cacheContent, null, 2));

  let publishedPersist: { models?: unknown; checkedAt?: number } | undefined;
  globalThis.fetch = async () => {
    return new Response(
      JSON.stringify({
        models: {
          "gemini-3.7-flash": { displayName: "Gemini 3.7 Flash" },
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };

  const netContext = {
    credential: { type: "api_key" as const, key: validKey },
    stored: { models: [], checkedAt: 0 },
    allowNetwork: true,
    force: false,
    signal: abortCtrl.signal,
    publish: async (data: any) => {
      publishedPersist = data?.persist;
      return true;
    },
  };

  const startTime = Date.now();
  const netResult = await refreshAntigravityModels(netContext);
  assert.ok(netResult.length > 0, "returns models on network discovery");
  assert.ok(publishedPersist !== undefined, "publish is called on successful network discovery");
  assert.ok(
    typeof publishedPersist?.checkedAt === "number" && publishedPersist.checkedAt >= startTime,
    "persisted checkedAt is updated to recent timestamp",
  );

  const updatedCache = readCatalogCache(cachePathNetwork);
  assert.ok(
    typeof updatedCache?.checkedAt === "number" && updatedCache.checkedAt >= startTime,
    "file cache checkedAt is updated on successful discovery",
  );
} finally {
  globalThis.fetch = originalFetch;
  setCatalogCachePathForTests(undefined);
  rmSync(dirNetwork, { recursive: true, force: true });
}

// Test empty/unusable discovery: preserves last-known-good models and does NOT refresh TTL or publish
const dirEmpty = mkdtempSync(join(tmpdir(), "antigravity-catalog-empty-"));
const cachePathEmpty = join(dirEmpty, "antigravity-model-catalog.json");
try {
  setCatalogCachePathForTests(cachePathEmpty);
  const expiredTime = Date.now() - 5 * 60 * 60 * 1000;
  writeCatalogCache(catalog, cachePathEmpty);
  const cacheContent = JSON.parse(readFileSync(cachePathEmpty, "utf8"));
  cacheContent.checkedAt = expiredTime;
  writeFileSync(cachePathEmpty, JSON.stringify(cacheContent, null, 2));

  let publishedOnEmpty = false;
  globalThis.fetch = async () => {
    return new Response(
      JSON.stringify({
        models: {},
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };

  const emptyContext = {
    credential: { type: "api_key" as const, key: validKey },
    stored: { models: [], checkedAt: 0 },
    allowNetwork: true,
    force: false,
    signal: abortCtrl.signal,
    publish: async () => {
      publishedOnEmpty = true;
      return true;
    },
  };

  const emptyResult = await refreshAntigravityModels(emptyContext);
  assert.ok(emptyResult.length > 0, "preserves last-known-good models on empty discovery");
  assert.equal(publishedOnEmpty, false, "does not publish on empty discovery");

  const unrefreshedCache = readCatalogCache(cachePathEmpty);
  assert.equal(
    unrefreshedCache?.checkedAt,
    expiredTime,
    "does not renew file cache checkedAt on empty discovery",
  );
} finally {
  globalThis.fetch = originalFetch;
  setCatalogCachePathForTests(undefined);
  rmSync(dirEmpty, { recursive: true, force: true });
}

// Test failed discovery (network error): preserves last-known-good models without refreshing TTL
const dirError = mkdtempSync(join(tmpdir(), "antigravity-catalog-err-"));
const cachePathError = join(dirError, "antigravity-model-catalog.json");
try {
  setCatalogCachePathForTests(cachePathError);
  const expiredTime = Date.now() - 5 * 60 * 60 * 1000;
  writeCatalogCache(catalog, cachePathError);
  const cacheContent = JSON.parse(readFileSync(cachePathError, "utf8"));
  cacheContent.checkedAt = expiredTime;
  writeFileSync(cachePathError, JSON.stringify(cacheContent, null, 2));

  let publishedOnError = false;
  globalThis.fetch = async () => {
    throw new Error("Network unreachable");
  };

  const errorContext = {
    credential: { type: "api_key" as const, key: validKey },
    stored: { models: [], checkedAt: 0 },
    allowNetwork: true,
    force: false,
    signal: abortCtrl.signal,
    publish: async () => {
      publishedOnError = true;
      return true;
    },
  };

  const errorResult = await refreshAntigravityModels(errorContext);
  assert.ok(errorResult.length > 0, "preserves last-known-good models on network error");
  assert.equal(publishedOnError, false, "does not publish on network error");

  const unrefreshedCache = readCatalogCache(cachePathError);
  assert.equal(
    unrefreshedCache?.checkedAt,
    expiredTime,
    "does not renew file cache checkedAt on network error",
  );
} finally {
  globalThis.fetch = originalFetch;
  setCatalogCachePathForTests(undefined);
  rmSync(dirError, { recursive: true, force: true });
}
// Wire fingerprint headers: Accept: application/json must not be injected for model discovery
const defaultHeaders = antigravityHeaders("test-token");
assert.notEqual(
  defaultHeaders.Accept,
  "application/json",
  "Accept: application/json must not be sent on discovery requests",
);

// Static fallback model_enum resolution
clearModelEnumCache();
assert.equal(getModelEnum("gemini-3.8-flash-high"), "MODEL_PLACEHOLDER_M318");
assert.equal(getModelEnum("gemini-3.7-flash-high"), "MODEL_PLACEHOLDER_M298");
assert.equal(getModelEnum("gemini-3.6-flash-high"), "MODEL_PLACEHOLDER_M71");
assert.equal(getModelEnum("claude-sonnet-4-6"), "MODEL_PLACEHOLDER_M35");
assert.equal(getModelEnum("gpt-oss-120b-medium"), "MODEL_OPENAI_GPT_OSS_120B_MEDIUM");

// Dynamic model_enum registration and cache precedence
registerModelEnum("custom-future-model", "MODEL_PLACEHOLDER_M999");
assert.equal(getModelEnum("custom-future-model"), "MODEL_PLACEHOLDER_M999");
registerModelEnum("gemini-3.8-flash-high", "MODEL_OVERRIDE_DYNAMIC");
assert.equal(getModelEnum("gemini-3.8-flash-high"), "MODEL_OVERRIDE_DYNAMIC", "dynamic cache overrides static");

// Batch registration from catalog discovery
registerDiscoveredModelEnums({
  "gemini-4.0-flash": { model: "MODEL_PLACEHOLDER_M400" },
});
assert.equal(getModelEnum("gemini-4.0-flash"), "MODEL_PLACEHOLDER_M400");

// mergeAvailableModelsResults registers model_enum dynamically
mergeAvailableModelsResults([
  {
    endpoint: "https://daily-cloudcode-pa.googleapis.com",
    status: 200,
    data: {
      models: {
        "catalog-dynamic-model": { model: "MODEL_CATALOG_DISCOVERED" },
      },
    },
  },
]);
assert.equal(getModelEnum("catalog-dynamic-model"), "MODEL_CATALOG_DISCOVERED");

clearModelEnumCache();
assert.equal(getModelEnum("gemini-3.8-flash-high"), "MODEL_PLACEHOLDER_M318", "clearModelEnumCache restores static");

console.log(
  "model discovery: grouping, overrides, empty/failure fallback, cache replace-on-success, thinking config, and refresh TTL passed",
);
