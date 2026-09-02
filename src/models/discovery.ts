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
} from "./models.js";
import { isUsableCatalog, readCatalogCache, writeCatalogCache } from "./cache.js";
import { buildAntigravityCatalog, resolvedCatalog, type AntigravityCatalog } from "./grouping.js";

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
  const models = available.data.models ?? {};
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

  try {
    const discovered = await discoverAntigravityModels(apiKey, context.signal);
    const next = resolvedCatalog(discovered, current);
    if (next !== current && isUsableCatalog(next)) {
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
  } catch {
    // Keep last-known-good models; a failed refresh must not wipe the catalog.
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
