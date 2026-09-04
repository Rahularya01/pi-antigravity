import type { Api, Credential, Model, RefreshModelsContext } from "@earendil-works/pi-ai";
import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { getApiKey } from "../auth/index.js";
import { DEFAULT_ENDPOINT, fetchAvailableModelsCatalog, parseApiKey } from "../client/index.js";
import { ANTIGRAVITY_API } from "../types/types.js";
import {
  ANTIGRAVITY_MODELS,
  ANTIGRAVITY_ROUTING,
  applyAntigravityCatalog,
  getCurrentAntigravityCatalog,
  PROVIDER_ID,
  registerDiscoveredModelEnums,
} from "./models.js";
import { isUsableCatalog, readCatalogCache, writeCatalogCache } from "./cache.js";
import { buildAntigravityCatalog, resolvedCatalog, type AntigravityCatalog } from "./grouping.js";
import { antigravityEnv } from "../utils/util.js";

export const DEFAULT_CATALOG_REFRESH_INTERVAL_MS = 4 * 60 * 60 * 1000;

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

export function loadInitialAntigravityCatalog(): AntigravityCatalog {
  const cached = readCatalogCache();
  if (cached) {
    applyAntigravityCatalog(cached);
    return cached;
  }
  const fallback = fallbackCatalog();
  applyAntigravityCatalog(fallback);
  return fallback;
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
  const current = getCurrentAntigravityCatalog();
  if (!context.allowNetwork) {
    return current.models;
  }

  const apiKey = apiKeyFromCredential(context.credential);
  if (!apiKey || context.signal.aborted) {
    return current.models;
  }

  const lastCheckedAt = Math.max(
    context.stored?.checkedAt ?? 0,
    readCatalogCache()?.checkedAt ?? 0,
  );
  const now = Date.now();
  if (
    !context.force &&
    lastCheckedAt > 0 &&
    now >= lastCheckedAt &&
    now - lastCheckedAt < getCatalogRefreshIntervalMs()
  ) {
    return current.models;
  }

  try {
    const discovered = await discoverAntigravityModels(apiKey, context.signal);
    if (context.signal.aborted) return current.models;
    const next = resolvedCatalog(discovered, current);
    if (isUsableCatalog(discovered)) {
      applyAntigravityCatalog(next);
      writeCatalogCache(next);
      await context.publish({
        persist: {
          models: toStoredModels(next.models),
          checkedAt: Date.now(),
        },
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
    provider: PROVIDER_ID,
    baseUrl: DEFAULT_ENDPOINT,
  }));
}
