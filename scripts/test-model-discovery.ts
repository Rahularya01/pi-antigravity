import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import {
  antigravityHeaders,
  defaultUserAgent,
  fetchAvailableRuntimeModel,
  mergeAvailableModelsResults,
} from "../src/client/index.js";
import {
  ANTIGRAVITY_MODELS,
  ANTIGRAVITY_PERSIST_KEY,
  ANTIGRAVITY_ROUTING,
  CATALOG_SCHEMA_VERSION,
  applyAntigravityCatalog,
  buildAntigravityCatalog,
  clearModelEnumCache,
  extractRecommendedModelIds,
  getAntigravityRequestModelId,
  getFallbackRuntimeModel,
  getModelEnum,
  getMaxOutputTokens,
  hydrateAntigravityCatalog,
  refreshAntigravityModels,
  registerModelEnum,
  resetAntigravityCatalogForTests,
  snapshotDynamicModelEnums,
  type AntigravityCatalog,
} from "../src/models/index.js";
import type { ModelInfoRaw } from "../src/types/types.js";

const fallback: AntigravityCatalog = { models: ANTIGRAVITY_MODELS, routing: ANTIGRAVITY_ROUTING };
const info = (displayName: string, extra?: Partial<ModelInfoRaw>): ModelInfoRaw => ({
  displayName,
  supportsThinking: true,
  supportsImages: true,
  ...extra,
});

const catalog = buildAntigravityCatalog(
  {
    "gemini-3.9-flash-low": info("Gemini 3.9 Flash (Low)"),
    "gemini-3.9-flash-medium": info("Gemini 3.9 Flash (Medium)"),
    "gemini-3.9-flash-high": info("Gemini 3.9 Flash (High)"),
    chat_hidden: info("Hidden chat"),
    "gemini-3-pro-image": info("Gemini 3 Pro Image"),
  },
  fallback,
);
assert(
  catalog.models.some((model) => model.id === "gemini-3.9-flash"),
  "discovers new model families",
);
assert(!catalog.models.some((model) => model.id === "chat_hidden"), "filters hidden models");
assert(!catalog.models.some((model) => model.id === "gemini-3-pro-image"), "filters image models");
assert(
  catalog.routing["gemini-3.9-flash"]?.routing?.medium === "gemini-3.9-flash-medium",
  "routes discovered thinking variants",
);

// Future versions, live metadata, and removals must not depend on static entries.
const future = {
  "gemini-99-flash-low": info("Gemini 99 Flash (Low)", {
    maxTokens: 1000000,
    maxOutputTokens: 128000,
  }),
  "gemini-99-flash-high": info("Gemini 99 Flash (High)", {
    maxTokens: 1000000,
    maxOutputTokens: 32000,
  }),
  "claude-sonnet-99-medium": info("Claude Sonnet 99 (Medium)", {
    maxTokens: 1000000,
    maxOutputTokens: 128000,
  }),
};
const futureCatalog = buildAntigravityCatalog(future, fallback);
assert.deepEqual(
  futureCatalog.models.map((model) => model.id).sort(),
  ["claude-sonnet-99", "gemini-99-flash"],
  "does not re-inject absent static models",
);
assert.equal(futureCatalog.routing["gemini-99-flash"].routing?.high, "gemini-99-flash-high");
assert.equal(futureCatalog.routing["claude-sonnet-99"].routing?.medium, "claude-sonnet-99-medium");
assert.equal(
  futureCatalog.models.find((model) => model.id === "gemini-99-flash")?.maxTokens,
  32000,
  "grouped limits use the smallest advertised value",
);
const futureClaude = futureCatalog.models.find((model) => model.id === "claude-sonnet-99")!;
assert.equal(futureClaude.contextWindow, 1000000);
assert.equal(futureClaude.maxTokens, 128000);
try {
  applyAntigravityCatalog(futureCatalog);
  assert.equal(
    getMaxOutputTokens("claude-sonnet-99", "claude-sonnet-99-medium"),
    128000,
    "request clamping uses discovered limits",
  );
} finally {
  resetAntigravityCatalogForTests();
}

const knownId = ANTIGRAVITY_MODELS[0].id;
// A resumed session may still select a static model removed by live curation.
try {
  const active = buildAntigravityCatalog(
    { "gemini-3.8-flash-low": info("Gemini 3.8 Flash (Low)") },
    fallback,
  );
  applyAntigravityCatalog(active);
  for (const retired of ["gemini-3.6-flash", "gemini-3.7-flash"]) {
    assert.throws(
      () => getAntigravityRequestModelId(retired, "medium"),
      /absent from the current catalog.*\/antigravity.refresh/,
      "retired selections must not recover static runtime routes",
    );
  }
  assert.equal(getAntigravityRequestModelId("gemini-3.8-flash", "medium"), "gemini-3.8-flash-low");
  assert.equal(getAntigravityRequestModelId("custom-runtime", "medium"), "custom-runtime");
  assert.equal(getFallbackRuntimeModel("gemini-3.8-flash-low"), undefined);
  assert.equal(getFallbackRuntimeModel("gemini-3.7-flash-tiered", "medium"), undefined);
  applyAntigravityCatalog(buildAntigravityCatalog({
    "gemini-3.8-flash-low": info("Gemini 3.8 Flash (Low)"),
    "gemini-3.7-flash-low": info("Gemini 3.7 Flash (Low)"),
  }, fallback));
  assert.equal(getFallbackRuntimeModel("gemini-3.8-flash-low"), "gemini-3.7-flash-low");
} finally {
  resetAntigravityCatalogForTests();
}
assert.equal(getAntigravityRequestModelId("gemini-3.6-flash", "medium"), "gemini-3.6-flash-medium");

const updated = buildAntigravityCatalog(
  {
    [knownId + "-low"]: info("Updated model (Low)", {
      supportsImages: false,
      maxTokens: -1,
      maxOutputTokens: "invalid",
    }),
  },
  fallback,
);
assert.deepEqual(updated.models[0].input, ["text"], "live capabilities override static metadata");
assert.equal(
  updated.routing[knownId].routing?.high,
  knownId + "-low",
  "static routes cannot target absent variants",
);
assert.ok(updated.models[0].contextWindow > 0);
assert.equal(typeof updated.models[0].maxTokens, "number", "invalid limits use defaults");

const renamed = buildAntigravityCatalog(
  {
    "gemini-99-flash-ultra": info("Gemini 99 Flash Ultra"),
    runtime_abc123: info("Future Model"),
    "mercury-99-flash-high": info("Mercury 99 Flash (High)"),
    runtime_hidden: info("Internal Model", { isInternal: true }),
    chat_hidden: info("Hidden chat"),
    "gemini-99-image": info("Gemini Image"),
  },
  fallback,
);
assert.equal(renamed.models.length, 3, "internal, chat, and image entries stay hidden");
assert.equal(renamed.routing["gemini-99-flash-ultra"].defaultRequestId, "gemini-99-flash-ultra");
assert.equal(
  renamed.routing.runtime_abc123.defaultRequestId,
  "runtime_abc123",
  "unfamiliar IDs remain exact runtime IDs",
);
assert.equal(
  renamed.routing["mercury-99-flash"].routing?.high,
  "mercury-99-flash-high",
  "brand-agnostic model discovery discovers new families",
);

const aliases = buildAntigravityCatalog(
  {
    "gemini-101-pro-low": info("Gemini 101 Pro (Low)"),
    "gemini-pro-agent": info("Gemini 101 Pro (High)"),
  },
  fallback,
);
assert.equal(aliases.models.length, 1);
assert.equal(
  aliases.routing["gemini-101-pro"].routing?.high,
  "gemini-pro-agent",
  "agent aliases follow current metadata, not pinned versions",
);

// Explicit capability denial must prevent an agent from becoming a thinking
// route, even if its display name suggests High. Omitted metadata still merges.
for (const supportsThinking of [false, true, undefined]) {
  const grouped = buildAntigravityCatalog(
    {
      "gemini-101-pro-low": info("Gemini 101 Pro (Low)"),
      "gemini-pro-agent": info("Gemini 101 Pro (High)", { supportsThinking }),
    },
    fallback,
  );
  const route = grouped.routing["gemini-101-pro"];
  if (supportsThinking === false) {
    assert.equal(grouped.models.length, 2);
    assert.ok(grouped.routing["gemini-pro-agent"], "non-thinking agent stays separate");
    assert.equal(
      route.routing?.high,
      "gemini-101-pro-low",
      "explicitly non-thinking agent must not become the target's High route",
    );
    const agentModel = grouped.models.find((m) => m.id === "gemini-pro-agent");
    assert.equal(agentModel?.reasoning, false, "explicit denial stops reasoning flag");
    assert.equal(agentModel?.thinkingLevelMap, undefined, "explicit denial stops thinkingLevelMap");
  } else {
    assert.equal(grouped.models.length, 1);
    assert.equal(route.routing?.high, "gemini-pro-agent");
  }
}

// Agent groups with multiple runtimes must remain independently routable,
// including a group with both an unsuffixed runtime and a thinking variant.
for (const agentModels of [
  {
    "gemini-pro-agent-low": info("Gemini 101 Pro (Low)"),
    "gemini-pro-agent-high": info("Gemini 101 Pro (High)"),
  },
  {
    "gemini-pro-agent": info("Gemini 101 Pro"),
    "gemini-pro-agent-high": info("Gemini 101 Pro (High)"),
  },
]) {
  const grouped = buildAntigravityCatalog(
    {
      "gemini-101-pro-medium": info("Gemini 101 Pro (Medium)"),
      ...agentModels,
    },
    fallback,
  );
  assert.equal(grouped.models.length, 2);
  const agentRoute = grouped.routing["gemini-pro-agent"];
  assert.ok(agentRoute, "multi-runtime agent group must not be deleted");
  assert.equal(agentRoute.routing?.high, "gemini-pro-agent-high");
  if ("gemini-pro-agent-low" in agentModels) {
    assert.equal(agentRoute.routing?.low, "gemini-pro-agent-low");
  }
}

const suffixedAlias = buildAntigravityCatalog(
  {
    "gemini-101-pro-medium": info("Gemini 101 Pro (Medium)"),
    "gemini-pro-agent-high": info("Gemini 101 Pro"),
  },
  fallback,
);
assert.equal(suffixedAlias.models.length, 1);
assert.equal(suffixedAlias.routing["gemini-101-pro"].routing?.high, "gemini-pro-agent-high");

// The live probe must continue and summarize when one endpoint has no supported
// chat entries. Fake credentials and fetch keep this subprocess entirely offline.
const probeDir = mkdtempSync(join(tmpdir(), "antigravity-probe-"));
try {
  const authFile = join(probeDir, "auth.json");
  writeFileSync(authFile, JSON.stringify({ antigravity: { access: "fake", projectId: "fake" } }));
  const probe = spawnSync(
    process.execPath,
    [
      "scripts/run-ts.mjs",
      "-e",
      `
    let calls = 0;
    globalThis.fetch = async () => new Response(JSON.stringify({
      models: ++calls === 1
        ? { chat_hidden: { displayName: "Hidden chat" } }
        : { "gemini-99-flash-low": { displayName: "Gemini 99 Flash (Low)" } },
    }));
    await import("./scripts/probe-model-discovery.mjs");
  `,
    ],
    {
      env: { ...process.env, PI_AUTH_PATH: authFile, ANTIGRAVITY_BASE_URL: "" },
      encoding: "utf8",
      timeout: 15000,
    },
  );
  assert.ifError(probe.error);
  assert.equal(probe.status, 1, "unsupported catalog is a probe failure");
  assert.match(probe.stdout, /FAIL .* supported chat catalog/);
  assert.match(probe.stdout, /PASS https:\/\/cloudcode-pa.googleapis.com supported chat catalog/);
  assert.match(probe.stdout, /Live discovery probe: 9 passed, 1 failed/);
} finally {
  rmSync(probeDir, { recursive: true, force: true });
}

const merged = mergeAvailableModelsResults([
  { endpoint: "valid", status: 200, data: { models: future } },
  { endpoint: "invalid", status: 200, data: { models: { broken: null } } },
]);
assert.deepEqual(merged.data.models, future, "a malformed endpoint cannot overwrite valid models");
assert.equal(merged.endpoint, "valid");
for (const models of [{}, [], { broken: "not metadata" }]) {
  assert.throws(() =>
    mergeAvailableModelsResults([{ endpoint: "invalid", status: 200, data: { models } }]),
  );
}

// Provider-owned persistence restores routing and dynamic enums before offline/network checks.
const dynamicCatalog = buildAntigravityCatalog(
  { "gemini-9.9-flash-low": info("Gemini 9.9 Flash (Low)") },
  fallback,
);
applyAntigravityCatalog(dynamicCatalog);
clearModelEnumCache();
registerModelEnum("gemini-9.9-flash-low", "MODEL_DYNAMIC_999");
const stored = {
  [ANTIGRAVITY_PERSIST_KEY]: {
    catalog: dynamicCatalog,
    checkedAt: Date.now(),
    modelEnums: snapshotDynamicModelEnums(),
    schemaVersion: CATALOG_SCHEMA_VERSION,
    credentialKey: createHash("sha256")
      .update(JSON.stringify([JSON.stringify({ token: "fake", projectId: "fake" }), "fake"]))
      .digest("hex"),
  },
};
resetAntigravityCatalogForTests();
clearModelEnumCache();

const originalFetch = globalThis.fetch;
let networkCalled = false;
globalThis.fetch = async () => {
  networkCalled = true;
  throw new Error("offline restart must not fetch");
};
try {
  const offline = await refreshAntigravityModels({
    credential: undefined,
    stored,
    allowNetwork: false,
    force: false,
    signal: new AbortController().signal,
    publish: async () => true,
  });
  assert(
    offline.some((model) => model.id === "gemini-9.9-flash"),
    "dynamic-only models survive an offline restart",
  );
  assert(
    getAntigravityRequestModelId("gemini-9.9-flash", "low") === "gemini-9.9-flash-low",
    "offline restart restores dynamic routing",
  );
  assert(getModelEnum("gemini-9.9-flash-low") === "MODEL_DYNAMIC_999", "restores dynamic enums");
  assert(
    getModelEnum("gemini-9.9-flash") === "MODEL_DYNAMIC_999",
    "base runtime overrides resolve a routed dynamic enum",
  );
  assert(!networkCalled, "offline refresh does not touch the network");
} finally {
  globalThis.fetch = originalFetch;
}

// Fresh persisted state is hydrated before the TTL check.
globalThis.fetch = async () => {
  networkCalled = true;
  throw new Error("fresh catalog should skip network");
};
try {
  await refreshAntigravityModels({
    credential: { type: "api_key", key: JSON.stringify({ token: "fake", projectId: "fake" }) },
    stored,
    allowNetwork: true,
    force: false,
    signal: new AbortController().signal,
    publish: async () => true,
  });
  assert(!networkCalled, "fresh persisted state skips discovery");
} finally {
  globalThis.fetch = originalFetch;
}

// Account/project changes and older cache schemas bypass even a fresh TTL.
for (const change of [
  { credentialKey: "another-account" },
  { schemaVersion: CATALOG_SCHEMA_VERSION - 1 },
]) {
  networkCalled = false;
  globalThis.fetch = async () => {
    networkCalled = true;
    throw new Error("simulated network failure");
  };
  try {
    const result = await refreshAntigravityModels({
      credential: { type: "api_key", key: JSON.stringify({ token: "fake", projectId: "fake" }) },
      stored: {
        ...stored,
        [ANTIGRAVITY_PERSIST_KEY]: { ...stored[ANTIGRAVITY_PERSIST_KEY], ...change },
      },
      allowNetwork: true,
      force: false,
      signal: new AbortController().signal,
      publish: async () => true,
    });
    assert(networkCalled, "different source/schema bypasses TTL");
    assert(
      result.some((model) => model.id === "gemini-9.9-flash"),
      "failed refresh retains last-known-good models",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
}

// A successful discovery stores all extension-private state in models-store.json.
let published: unknown;
globalThis.fetch = async () =>
  new Response(
    JSON.stringify({
      models: {
        "gemini-10.0-flash-low": {
          displayName: "Gemini 10.0 Flash (Low)",
          model: "MODEL_DYNAMIC_1000",
        },
      },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
try {
  await refreshAntigravityModels({
    credential: { type: "api_key", key: JSON.stringify({ token: "fake", projectId: "fake" }) },
    stored: undefined,
    allowNetwork: true,
    force: true,
    signal: new AbortController().signal,
    publish: async (value: unknown) => {
      published = value;
      return true;
    },
  });
  const persisted = (published as { persist?: Record<string, unknown> } | undefined)?.persist?.[
    ANTIGRAVITY_PERSIST_KEY
  ] as { catalog?: AntigravityCatalog; modelEnums?: Record<string, string> } | undefined;
  assert(persisted?.catalog?.routing, "persists routing with the model list");
  assert(
    persisted?.modelEnums?.["gemini-10.0-flash-low"] === "MODEL_DYNAMIC_1000",
    "persists discovered enum values",
  );
} finally {
  globalThis.fetch = originalFetch;
  resetAntigravityCatalogForTests();
  clearModelEnumCache();
}

// Failed refreshes must not publish or replace last-known-good state.
for (const response of ["offline", "renamed-schema"]) {
  globalThis.fetch = async () => {
    if (response === "offline") throw new Error("offline");
    return new Response(JSON.stringify({ renamedModels: future }));
  };
  let didPublish = false;
  const context = {
    credential: {
      type: "api_key" as const,
      key: JSON.stringify({ token: "fake", projectId: "fake" }),
    },
    stored: {
      ...stored,
      [ANTIGRAVITY_PERSIST_KEY]: { ...stored[ANTIGRAVITY_PERSIST_KEY], checkedAt: 1 },
    },
    allowNetwork: true,
    force: false,
    signal: new AbortController().signal,
    publish: async () => {
      didPublish = true;
      return true;
    },
  };
  try {
    assert.deepEqual(await refreshAntigravityModels(context), dynamicCatalog.models);
    await assert.rejects(
      () => refreshAntigravityModels({ ...context, force: true }),
      "forced refresh reports discovery failures",
    );
    assert.equal(didPublish, false, "failed discovery must not publish");
  } finally {
    globalThis.fetch = originalFetch;
    resetAntigravityCatalogForTests();
    clearModelEnumCache();
  }
}

assert(hydrateAntigravityCatalog(undefined) === 0, "ignores absent stored data");
assert(
  hydrateAntigravityCatalog({ [ANTIGRAVITY_PERSIST_KEY]: {} }) === 0,
  "ignores malformed state",
);
mergeAvailableModelsResults([
  {
    endpoint: "https://cloudcode-pa.googleapis.com",
    status: 200,
    data: { models: { "catalog-dynamic": { model: "MODEL_CATALOG_DYNAMIC" } } },
  },
]);
assert(getModelEnum("catalog-dynamic") === "MODEL_CATALOG_DYNAMIC", "registers discovery enums");
assert(
  !("Accept" in antigravityHeaders("test-token")),
  "discovery must not inject an Accept header",
);

// Opaque runtime IDs require exact key matches and do not match near-miss prefix keys.
let endpointProbeCount = 0;
globalThis.fetch = async () => {
  endpointProbeCount++;
  if (endpointProbeCount === 1) {
    // First endpoint has near-miss prefix
    return new Response(
      JSON.stringify({ models: { runtime_abc1234: { displayName: "Near miss" } } }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }
  // Second endpoint has exact key
  return new Response(
    JSON.stringify({ models: { runtime_abc123: { displayName: "Exact match" } } }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
};
try {
  const match = await fetchAvailableRuntimeModel("test-token-exact", "test-proj", "runtime_abc123");
  assert.equal(
    match?.id,
    "runtime_abc123",
    "opaque runtime ID matches exact key on second endpoint, not near-miss prefix on first",
  );
} finally {
  globalThis.fetch = originalFetch;
}

// Unfamiliar suffix IDs (e.g. gemini-3.8-flash-ultra) must not fuzzy-match other models by display name or prefix.
globalThis.fetch = async () =>
  new Response(
    JSON.stringify({
      models: {
        "gemini-3.8-flash-high": { displayName: "Gemini 3.8 Flash (High)" },
      },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
try {
  const match = await fetchAvailableRuntimeModel(
    "test-token-ultra",
    "test-proj",
    "gemini-3.8-flash-ultra",
  );
  assert.equal(match, undefined, "unfamiliar suffix does not fuzzy match different models");
} finally {
  globalThis.fetch = originalFetch;
}

// Gemini 4 is advertised only to current client versions (#93, #94, #96).
const savedUserAgent = process.env.ANTIGRAVITY_USER_AGENT;
const savedLegacyUserAgent = process.env.NOAGY_USER_AGENT;
let argonPersisted: unknown;
globalThis.fetch = async (_input, init) => {
  const headers = new Headers(init?.headers);
  const currentClient = headers.get("User-Agent") === defaultUserAgent();
  return new Response(
    JSON.stringify({
      models: currentClient
        ? {
            "gemini-4-argon-low": info("Gemini 4 Argon (Low)", { model: "MODEL_ARGON_LOW_TEST" }),
            "gemini-4-argon-medium": info("Gemini 4 Argon (Medium)", {
              model: "MODEL_ARGON_MEDIUM_TEST",
            }),
            "gemini-4-argon-high": info("Gemini 4 Argon (High)", {
              model: "MODEL_ARGON_HIGH_TEST",
            }),
          }
        : { "gemini-3.8-flash-low": info("Gemini 3.8 Flash (Low)") },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
};
try {
  delete process.env.ANTIGRAVITY_USER_AGENT;
  delete process.env.NOAGY_USER_AGENT;
  const models = await refreshAntigravityModels({
    credential: { type: "api_key", key: JSON.stringify({ token: "fake", projectId: "fake" }) },
    stored: undefined,
    allowNetwork: true,
    force: true,
    signal: new AbortController().signal,
    publish: async (value: unknown) => {
      argonPersisted = value;
      return true;
    },
  });
  assert(
    !ANTIGRAVITY_MODELS.some((model) => model.id === "gemini-4-argon"),
    "Gemini 4 must come from authenticated discovery, not a static fallback",
  );
  const argon = models.find((model) => model.id === "gemini-4-argon");
  assert(argon, "default client headers discover Gemini 4 without environment overrides");
  assert(argon.reasoning && argon.input.includes("image"), "retains advertised capabilities");
  for (const effort of ["low", "medium", "high"] as const) {
    assert(argon.thinkingLevelMap?.[effort] === effort, `exposes Argon ${effort} thinking`);
    assert(
      getAntigravityRequestModelId(argon.id, effort) === `gemini-4-argon-${effort}`,
      `routes Argon ${effort} to its exact runtime`,
    );
    assert(
      getFallbackRuntimeModel(`gemini-4-argon-${effort}`) === undefined,
      "never silently substitutes another generation for Gemini 4",
    );
  }
  assert(getModelEnum("gemini-4-argon-high") === "MODEL_ARGON_HIGH_TEST", "uses discovered enum");
  resetAntigravityCatalogForTests();
  clearModelEnumCache();
  const persisted = (argonPersisted as { persist?: Record<string, unknown> }).persist;
  const offline = await refreshAntigravityModels({
    credential: undefined,
    stored: persisted,
    allowNetwork: false,
    force: false,
    signal: new AbortController().signal,
    publish: async () => true,
  });
  assert(offline.some((model) => model.id === "gemini-4-argon"), "Argon survives offline restart");
} finally {
  globalThis.fetch = originalFetch;
  if (savedUserAgent === undefined) delete process.env.ANTIGRAVITY_USER_AGENT;
  else process.env.ANTIGRAVITY_USER_AGENT = savedUserAgent;
  if (savedLegacyUserAgent === undefined) delete process.env.NOAGY_USER_AGENT;
  else process.env.NOAGY_USER_AGENT = savedLegacyUserAgent;
  resetAntigravityCatalogForTests();
  clearModelEnumCache();
}

// Curation via agentModelSorts (#97): active models prioritized, retired routes hidden
const sortsPayload = [
  {
    displayName: "Recommended",
    groups: [
      {
        modelIds: [
          "gemini-4-argon-medium",
          "gemini-4-argon-high",
          "gemini-4-argon-low",
          "gemini-3.8-flash-high",
          "gemini-3.8-flash-medium",
          "gemini-3.8-flash-low",
        ],
      },
    ],
  },
];
const recommendedSet = extractRecommendedModelIds(sortsPayload);
assert.equal(recommendedSet?.size, 6);
assert.ok(recommendedSet?.has("gemini-4-argon-medium"));
assert.equal(extractRecommendedModelIds(undefined), undefined);
assert.equal(extractRecommendedModelIds([]), undefined);

const mixedRawModels: Record<string, ModelInfoRaw> = {
  "gemini-4-argon-low": info("Gemini 4 Argon (Low)"),
  "gemini-4-argon-medium": info("Gemini 4 Argon (Medium)"),
  "gemini-4-argon-high": info("Gemini 4 Argon (High)"),
  "gemini-3.8-flash-low": info("Gemini 3.8 Flash (Low)"),
  "gemini-3.8-flash-medium": info("Gemini 3.8 Flash (Medium)"),
  "gemini-3.8-flash-high": info("Gemini 3.8 Flash (High)"),
  "gemini-pro-agent": info("Gemini Pro Agent (High)"),
  "gemini-2.5-flash-low": info("Gemini 2.5 Flash (Low)"),
  "gemini-3.1-pro-low": info("Gemini 3.1 Pro (Low)"),
};

const curatedCatalog = buildAntigravityCatalog(mixedRawModels, fallback, sortsPayload);
const curatedIds = curatedCatalog.models.map((m) => m.id);
assert.deepEqual(curatedIds.sort(), ["gemini-3.8-flash", "gemini-4-argon"].sort());
assert.ok(!curatedCatalog.routing["gemini-pro-agent"], "hides retired gemini-pro-agent");
assert.ok(!curatedCatalog.routing["gemini-2.5-flash"], "hides retired 2.5 variants");
assert.ok(!curatedCatalog.routing["gemini-3.1-pro"], "hides retired 3.1 variants");

// MergeAvailableModels carries agentModelSorts through
const mergedWithSorts = mergeAvailableModelsResults([
  {
    endpoint: "https://cloudcode-pa.googleapis.com",
    status: 200,
    data: {
      models: { "gemini-4-argon-low": info("Gemini 4 Argon (Low)") },
      agentModelSorts: sortsPayload,
    },
  },
]);
assert.deepEqual(mergedWithSorts.data.agentModelSorts, sortsPayload);

console.log("model discovery: live metadata, routing, validation, persistence, and TTL passed");
