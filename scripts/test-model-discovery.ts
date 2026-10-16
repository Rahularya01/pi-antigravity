import { antigravityHeaders, mergeAvailableModelsResults } from "../src/client/index.js";
import {
  ANTIGRAVITY_MODELS,
  ANTIGRAVITY_PERSIST_KEY,
  ANTIGRAVITY_ROUTING,
  applyAntigravityCatalog,
  buildAntigravityCatalog,
  clearModelEnumCache,
  getAntigravityRequestModelId,
  getFallbackRuntimeModel,
  getModelEnum,
  hydrateAntigravityCatalog,
  refreshAntigravityModels,
  registerModelEnum,
  resetAntigravityCatalogForTests,
  snapshotDynamicModelEnums,
  type AntigravityCatalog,
} from "../src/models/index.js";
import type { ModelInfoRaw } from "../src/types/types.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`FAILED: ${message}`);
}

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
assert(catalog.models.some((model) => model.id === "gemini-3.9-flash"), "discovers new model families");
assert(!catalog.models.some((model) => model.id === "chat_hidden"), "filters hidden models");
assert(!catalog.models.some((model) => model.id === "gemini-3-pro-image"), "filters image models");
assert(
  catalog.routing["gemini-3.9-flash"]?.routing?.medium === "gemini-3.9-flash-medium",
  "routes discovered thinking variants",
);

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

// Gemini 4 is advertised only to current client versions. Exercise the actual
// refresh/header path, not a manually inserted static model or runtime override.
const savedUserAgent = process.env.ANTIGRAVITY_USER_AGENT;
const savedLegacyUserAgent = process.env.NOAGY_USER_AGENT;
let argonPersisted: unknown;
globalThis.fetch = async (_input, init) => {
  const headers = new Headers(init?.headers);
  const currentClient = headers.get("User-Agent")?.startsWith("antigravity/cli/1.3.5 ");
  return new Response(
    JSON.stringify({
      models: currentClient
        ? {
            "gemini-4-argon-low": info("Gemini 4 Argon (Low)", {
              model: "MODEL_ARGON_LOW_TEST",
            }),
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
    "Gemini 4 must come from authenticated discovery, not an invented fallback entry",
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
  assert(argon.thinkingLevelMap?.off === null, "does not advertise unsupported off mode");
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
  assert(
    getAntigravityRequestModelId("gemini-4-argon", "medium") === "gemini-4-argon-medium",
    "offline restart preserves Argon medium routing",
  );
  assert(
    getModelEnum("gemini-4-argon-medium") === "MODEL_ARGON_MEDIUM_TEST",
    "offline restart preserves Argon dynamic enums",
  );
} finally {
  globalThis.fetch = originalFetch;
  if (savedUserAgent === undefined) delete process.env.ANTIGRAVITY_USER_AGENT;
  else process.env.ANTIGRAVITY_USER_AGENT = savedUserAgent;
  if (savedLegacyUserAgent === undefined) delete process.env.NOAGY_USER_AGENT;
  else process.env.NOAGY_USER_AGENT = savedLegacyUserAgent;
  resetAntigravityCatalogForTests();
  clearModelEnumCache();
}

assert(hydrateAntigravityCatalog(undefined) === 0, "ignores absent stored data");
assert(hydrateAntigravityCatalog({ [ANTIGRAVITY_PERSIST_KEY]: {} }) === 0, "ignores malformed state");
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

console.log("model discovery: persisted offline catalog, dynamic enums, and TTL passed");
