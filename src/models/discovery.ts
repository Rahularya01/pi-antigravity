import type {
  Api,
  Credential,
  Model,
  ModelsStoreEntry,
  RefreshModelsContext,
} from "@earendil-works/pi-ai";
import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { getApiKey } from "../auth/index.js";
import { DEFAULT_ENDPOINT, fetchAvailableModelsCatalog, parseApiKey } from "../client/index.js";
import { ANTIGRAVITY_API } from "../types/types.js";
import { antigravityEnv, isRecord } from "../utils/util.js";
import { buildAntigravityCatalog, resolvedCatalog, type AntigravityCatalog } from "./grouping.js";
import {
  ANTIGRAVITY_MODELS,
  ANTIGRAVITY_ROUTING,
  applyAntigravityCatalog,
  getCurrentAntigravityCatalog,
  registerDiscoveredModelEnums,
  restoreDynamicModelEnums,
  snapshotDynamicModelEnums,
} from "./models.js";

export const DEFAULT_CATALOG_REFRESH_INTERVAL_MS = 4 * 60 * 60 * 1000;
export const ANTIGRAVITY_PERSIST_KEY = "pi-antigravity";

type PersistedAntigravityCatalog = {
  catalog: AntigravityCatalog;
  checkedAt: number;
  modelEnums: Record<string, string>;
};

export function getCatalogRefreshIntervalMs(): number {
  const envVal =
    antigravityEnv("CATALOG_REFRESH_INTERVAL_MS") ?? antigravityEnv("REFRESH_INTERVAL_MS");
  if (envVal) {
    const parsed = Number.parseInt(envVal, 10);
    if (!Number.isNaN(parsed) && parsed >= 0) return parsed;
  }
  return DEFAULT_CATALOG_REFRESH_INTERVAL_MS;
}

const fallbackCatalog = (): AntigravityCatalog => ({
  models: ANTIGRAVITY_MODELS,
  routing: { ...ANTIGRAVITY_ROUTING },
});

/** Restore provider state supplied by Pi before checking offline mode or refresh TTL. */
export function hydrateAntigravityCatalog(stored: unknown): number {
  if (!isRecord(stored)) return 0;
  const persisted = stored[ANTIGRAVITY_PERSIST_KEY];
  if (!isRecord(persisted)) return 0;

  if (isStringMap(persisted.modelEnums)) restoreDynamicModelEnums(persisted.modelEnums);
  if (isCatalog(persisted.catalog)) applyAntigravityCatalog(persisted.catalog);
  return typeof persisted.checkedAt === "number" && persisted.checkedAt > 0
    ? persisted.checkedAt
    : 0;
}

export async function discoverAntigravityModels(
  apiKey: string,
  signal?: AbortSignal,
): Promise<AntigravityCatalog> {
  const creds = parseApiKey(apiKey);
  const available = await fetchAvailableModelsCatalog(creds.token, creds.projectId, signal);
  const models = available.data.models;
  if (!models || Object.keys(models).length === 0) {
    return { models: [], routing: {} };
  }
  registerDiscoveredModelEnums(models);
  return buildAntigravityCatalog(models, fallbackCatalog());
}

export async function refreshAntigravityModels(
  context: RefreshModelsContext,
): Promise<ProviderModelConfig[]> {
  const checkedAt = hydrateAntigravityCatalog(context.stored);
  const current = getCurrentAntigravityCatalog();
  if (!context.allowNetwork) return current.models;

  const apiKey = apiKeyFromCredential(context.credential);
  if (!apiKey || context.signal.aborted) return current.models;

  const now = Date.now();
  if (
    !context.force &&
    checkedAt > 0 &&
    now >= checkedAt &&
    now - checkedAt < getCatalogRefreshIntervalMs()
  ) {
    return current.models;
  }

  try {
    const discovered = await discoverAntigravityModels(apiKey, context.signal);
    if (context.signal.aborted) return current.models;
    const next = resolvedCatalog(discovered, current);
    if (next.models.length > 0 && discovered.models.length > 0) {
      applyAntigravityCatalog(next);
      const refreshedAt = Date.now();
      await context.publish({
        persist: {
          models: toStoredModels(next.models),
          [ANTIGRAVITY_PERSIST_KEY]: {
            catalog: next,
            checkedAt: refreshedAt,
            modelEnums: snapshotDynamicModelEnums(),
          } satisfies PersistedAntigravityCatalog,
        } as unknown as ModelsStoreEntry,
      });
      return next.models;
    }
  } catch (error) {
    // Keep last-known-good models; a failed refresh must not wipe the catalog.
    // Forced/manual refreshes must still report the failure to their caller.
    if (context.force) throw error;
  }

  return getCurrentAntigravityCatalog().models;
}

function isCatalog(value: unknown): value is AntigravityCatalog {
  return (
    isRecord(value) &&
    Array.isArray(value.models) &&
    value.models.length > 0 &&
    isRecord(value.routing)
  );
}

function isStringMap(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((entry) => typeof entry === "string");
}

function apiKeyFromCredential(credential: Credential | undefined): string | undefined {
  if (!credential) return undefined;
  if (credential.type === "api_key") {
    return typeof credential.key === "string" && credential.key ? credential.key : undefined;
  }
  if (credential.type === "oauth" && typeof credential.access === "string") {
    return getApiKey(credential);
  }
  return undefined;
}

function toStoredModels(models: ProviderModelConfig[]): Model<Api>[] {
  return models.map((model) => ({
    ...model,
    api: ANTIGRAVITY_API,
    provider: "antigravity",
    baseUrl: DEFAULT_ENDPOINT,
  }));
}
