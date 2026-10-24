import { createHash } from "node:crypto";
import {
  getCurrentAvailableModels,
  getCurrentEndpoint,
  getCurrentMatchedModelDebug,
  setLastAvailableModels,
  setLastEndpoint,
  setLastError,
  setLastMatchedModelDebug,
  setLastStatus,
} from "../diagnostics/diagnostics.js";
import { assertSafeApiBaseUrl, safeError } from "../utils/security.js";
import type { AntigravityApiKey, AvailableModelsRaw, DynamicModelInfo } from "../types/types.js";
import { antigravityEnv, asString, isRecord } from "../utils/util.js";
import { antigravityFetch } from "../utils/http.js";
import { registerDiscoveredModelEnums, registerModelEnum } from "../models/models.js";

export const DEFAULT_ENDPOINT = "https://daily-cloudcode-pa.googleapis.com";
export const ENDPOINT_FALLBACKS = [
  DEFAULT_ENDPOINT,
  "https://daily-cloudcode-pa.sandbox.googleapis.com",
  "https://cloudcode-pa.googleapis.com",
];

const PROJECT_CACHE_TTL_MS = 30 * 60 * 1000;
const projectCache = new Map<string, { projectId: string | undefined; expiresAt: number }>();

const MODEL_CACHE_TTL_MS = 30 * 60 * 1000;
const modelCache = new Map<string, { result: DynamicModelInfo | undefined; expiresAt: number }>();

/** Metadata lookups (project/model discovery) must be fast; a stalled endpoint should
 * fall through to the next candidate instead of hanging the whole request. */
const DISCOVERY_TIMEOUT_MS = 8000;

/** In-flight de-dupe: concurrent requests for the same (token, project, model) share one probe. */
const inFlightModelLookups = new Map<string, Promise<DynamicModelInfo | undefined>>();

/** UUID-shaped stable id from a seed (account email preferred over cwd). */
export function stableProjectId(seed: string): string {
  const bytes = createHash("sha1").update(`antigravity:${seed}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Fallback project id when discovery fails.
 * Prefer ANTIGRAVITY_PROJECT_ID, then a stable seed (email), never process.cwd().
 */
export function defaultProjectId(seed = "antigravity-default"): string {
  return antigravityEnv("PROJECT_ID")?.trim() || stableProjectId(seed);
}

/** @deprecated Use defaultProjectId(seed); kept for scripts that imported the old constant. */
export const DEFAULT_PROJECT_ID = defaultProjectId();

export function endpointCandidates(): string[] {
  const explicit = antigravityEnv("BASE_URL")?.trim();
  return explicit ? [assertSafeApiBaseUrl(explicit)] : ENDPOINT_FALLBACKS;
}

// Catalog visibility is gated on this version. 1.2.4 hides Gemini 4 Argon;
// 1.4.0 is aligned with the current official agy CLI release (#93, #94, #97).
const DEFAULT_USER_AGENT =
  "antigravity/cli/1.4.0 (aidev_client; os_type=linux; arch=amd64; cl=982146307; auth_method=consumer)";

/** Default User-Agent matching pure Antigravity CLI wire fingerprint. */
export function defaultUserAgent(): string {
  return DEFAULT_USER_AGENT;
}

/** HTTP headers for Antigravity API requests matching CLI wire traffic. */
export function antigravityHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    "User-Agent": antigravityEnv("USER_AGENT") || defaultUserAgent(),
  };
}

export function jsonOrTextError(text: string): string {
  try {
    const parsed = JSON.parse(text) as {
      error?: { message?: string; status?: string; code?: number };
    };
    if (typeof parsed.error?.message === "string") return parsed.error.message;
  } catch {
    // not JSON
  }
  return text;
}

export function parseApiKey(apiKeyRaw: string | undefined): AntigravityApiKey {
  if (!apiKeyRaw) {
    throw new Error("No Antigravity OAuth credentials. Run /login antigravity.");
  }
  try {
    const parsed: unknown = JSON.parse(apiKeyRaw);
    if (
      !isRecord(parsed) ||
      typeof parsed.token !== "string" ||
      !/^[\x21-\x7e]+$/.test(parsed.token) ||
      typeof parsed.projectId !== "string" ||
      !/^[\x21-\x7e]+$/.test(parsed.projectId)
    )
      throw new Error("missing token or projectId");
    return { token: parsed.token, projectId: parsed.projectId };
  } catch {
    // JSON parser errors can quote the credential input. Do not retain that cause.
    throw new Error("Invalid Antigravity credentials. Run /login antigravity.");
  }
}

export function extractProjectId(data: unknown): string | undefined {
  if (!isRecord(data)) return undefined;
  const direct =
    data.antigravityProjectId ??
    data.projectId ??
    data.backendProjectId ??
    data.userDefinedCloudaicompanionProject ??
    data.cloudaicompanionProject ??
    data.project;
  const directId = asString(direct);
  if (directId) return directId;
  if (isRecord(direct)) {
    const nestedId = asString(direct.id);
    if (nestedId) return nestedId;
  }
  for (const key of ["projects", "projectIds", "cloudaicompanionProjects"]) {
    const value = data[key];
    if (Array.isArray(value)) {
      for (const item of value) {
        const nested = extractProjectId(item);
        if (nested) return nested;
        const itemId = asString(item);
        if (itemId) return itemId;
      }
    }
  }
  return undefined;
}

async function listCloudAICompanionProjects(token: string): Promise<string | undefined> {
  for (const endpoint of endpointCandidates()) {
    try {
      const res = await antigravityFetch(`${endpoint}/v1internal:listCloudAICompanionProjects`, {
        method: "POST",
        headers: antigravityHeaders(token),
        body: JSON.stringify({}),
        signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
      });
      setLastStatus(res.status);
      setLastEndpoint(endpoint);
      if (!res.ok) continue;
      return extractProjectId(await res.json());
    } catch (error) {
      setLastError(safeError(error));
    }
  }
  return undefined;
}

function collectModelLabels(value: unknown, out: string[] = []): string[] {
  if (!value || out.length > 50) return out;
  if (typeof value === "string") {
    if (/gemini|claude|gpt-oss/i.test(value)) out.push(value);
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectModelLabels(item, out);
    return out;
  }
  if (isRecord(value)) {
    for (const key of ["id", "name", "label", "displayName", "model", "modelId"]) {
      collectModelLabels(value[key], out);
    }
    for (const nested of Object.values(value)) {
      if (nested && typeof nested === "object") collectModelLabels(nested, out);
    }
  }
  return out;
}

function summarizeModelCandidate(value: unknown): string {
  if (!isRecord(value)) return String(value ?? "none");
  const out: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (/token|auth|credential|secret|email/i.test(key)) continue;
    if (raw === null || ["string", "number", "boolean"].includes(typeof raw)) out[key] = raw;
    else if (Array.isArray(raw)) out[key] = `[array:${String(raw.length)}]`;
    else if (isRecord(raw)) {
      out[key] = `{${Object.keys(raw).slice(0, 12).join(",")}}`;
    }
  }
  return JSON.stringify(out).slice(0, 1200);
}

/** Runtime ids must not be internal placeholder enums, internal chats, or image endpoints. */
export function isUsableRuntimeModelId(id: string): boolean {
  return (
    /^[a-z0-9][a-z0-9_.-]*$/i.test(id) &&
    !/\s/.test(id) &&
    !/^MODEL_/i.test(id) &&
    !/^(chat_|tab_)/i.test(id) &&
    !/image/i.test(id)
  );
}

function dynamicModelFromInfo(modelId: string, info: unknown): DynamicModelInfo {
  if (!isRecord(info)) return { id: modelId };
  setLastMatchedModelDebug(summarizeModelCandidate({ modelId, ...info }));
  const experiments = Array.isArray(info.modelExperiments)
    ? info.modelExperiments.filter((item): item is string => typeof item === "string")
    : undefined;
  const modelEnum = asString(info.model);
  if (modelEnum) {
    registerModelEnum(modelId, modelEnum);
  }
  return {
    id: modelId,
    experiments,
    apiProvider: asString(info.apiProvider),
    modelProvider: asString(info.modelProvider),
    model: modelEnum,
  };
}

/**
 * Resolve a requested runtime model against fetchAvailableModels payload.
 * The real runtime ids are the keys of `data.models`; the nested `model` field is often
 * a MODEL_PLACEHOLDER_* enum that 404s on streamGenerateContent.
 *
 * Uses deterministic key lookup (exact or case-insensitive) and exact display name match.
 * Zero regexes, zero prefix wildcards, zero fuzzy guessing.
 */
function findDynamicModel(value: unknown, requestedId: string): DynamicModelInfo | undefined {
  if (!value) return undefined;

  if (isRecord(value) && isRecord(value.models)) {
    const modelsMap = value.models;
    // 1. Direct exact key lookup
    if (isUsableRuntimeModelId(requestedId) && requestedId in modelsMap) {
      return dynamicModelFromInfo(requestedId, modelsMap[requestedId]);
    }
    // 2. Case-insensitive exact key lookup
    const lowerReq = requestedId.toLowerCase();
    for (const [modelId, info] of Object.entries(modelsMap)) {
      if (modelId.toLowerCase() === lowerReq && isUsableRuntimeModelId(modelId)) {
        return dynamicModelFromInfo(modelId, info);
      }
    }
    // 3. Exact display name lookup (for when a user references an exact model label)
    for (const [modelId, info] of Object.entries(modelsMap)) {
      if (!isUsableRuntimeModelId(modelId)) continue;
      if (isRecord(info)) {
        const label = info.label ?? info.displayName ?? info.name;
        if (typeof label === "string" && label.toLowerCase() === lowerReq) {
          return dynamicModelFromInfo(modelId, info);
        }
      }
    }
    return undefined;
  }

  if (typeof value === "string") {
    return value.toLowerCase() === requestedId.toLowerCase() && isUsableRuntimeModelId(value)
      ? { id: value }
      : undefined;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findDynamicModel(item, requestedId);
      if (found) return found;
    }
    return undefined;
  }
  if (isRecord(value)) {
    for (const nested of Object.values(value)) {
      if (nested && typeof nested === "object") {
        const found = findDynamicModel(nested, requestedId);
        if (found) return found;
      }
    }
  }
  return undefined;
}

async function fetchAvailableRuntimeModelUncached(
  token: string,
  projectId: string,
  requestedRuntimeModel: string,
): Promise<DynamicModelInfo | undefined> {
  const body = JSON.stringify({ project: projectId });
  const endpoints = endpointCandidates();
  let lastLabels = "";

  // Try endpoints in priority order (production first). If the primary endpoint
  // resolves the model, return immediately without waiting on slower sandbox endpoints.
  for (const endpoint of endpoints) {
    try {
      const res = await antigravityFetch(`${endpoint}/v1internal:fetchAvailableModels`, {
        method: "POST",
        headers: antigravityHeaders(token),
        body,
        signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
      });
      setLastStatus(res.status);
      if (!res.ok) continue;
      setLastEndpoint(endpoint);
      const data: unknown = await res.json();
      if (isRecord(data) && isRecord(data.models)) {
        registerDiscoveredModelEnums(data.models as Record<string, { model?: unknown }>);
      }
      const labels = [...new Set(collectModelLabels(data))].slice(0, 16);
      if (labels.length) lastLabels = labels.join(",");
      const found = findDynamicModel(data, requestedRuntimeModel);
      if (found) {
        if (lastLabels) setLastAvailableModels(lastLabels);
        return found;
      }
    } catch (error) {
      setLastError(safeError(error));
    }
  }

  if (lastLabels) setLastAvailableModels(lastLabels);
  return undefined;
}

export async function fetchAvailableRuntimeModel(
  token: string,
  projectId: string,
  requestedRuntimeModel: string,
): Promise<DynamicModelInfo | undefined> {
  const cacheKey = JSON.stringify([tokenFingerprint(token), projectId, requestedRuntimeModel]);
  const cached = modelCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.result;

  // De-dupe concurrent lookups for the same key (e.g. parallel requests right after
  // startup) so they share one probe instead of each firing their own round-trips.
  const inFlight = inFlightModelLookups.get(cacheKey);
  if (inFlight) return inFlight;

  const promise = fetchAvailableRuntimeModelUncached(token, projectId, requestedRuntimeModel).then(
    (result) => {
      modelCache.set(cacheKey, { result, expiresAt: Date.now() + MODEL_CACHE_TTL_MS });
      return result;
    },
  );
  inFlightModelLookups.set(cacheKey, promise);
  try {
    return await promise;
  } finally {
    inFlightModelLookups.delete(cacheKey);
    // Evict expired entries; bound map size to avoid unbounded growth.
    if (modelCache.size > 64) {
      const now = Date.now();
      for (const [key, entry] of modelCache) {
        if (entry.expiresAt <= now) modelCache.delete(key);
      }
    }
  }
}

export function clearModelCache(): void {
  modelCache.clear();
}

async function fetchAvailableModelsFromEndpoint(
  endpoint: string,
  token: string,
  projectId: string,
  signal?: AbortSignal,
): Promise<{ endpoint: string; status: number; data: unknown } | undefined> {
  try {
    const res = await antigravityFetch(`${endpoint}/v1internal:fetchAvailableModels`, {
      method: "POST",
      headers: antigravityHeaders(token),
      body: JSON.stringify({ project: projectId }),
      signal: catalogSignal(signal),
    });
    const text = await res.text();
    let data: unknown;
    try {
      data = JSON.parse(text) as unknown;
    } catch {
      data = { raw: text };
    }
    if (!res.ok) {
      const message =
        isRecord(data) && isRecord(data.error) && typeof data.error.message === "string"
          ? data.error.message
          : text;
      setLastError(message);
      return undefined;
    }
    return { endpoint, status: res.status, data };
  } catch (error) {
    setLastError(safeError(error));
    return undefined;
  }
}

function catalogSignal(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(DISCOVERY_TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

/** Merge catalog payloads from one or more fetchAvailableModels responses. */
export function mergeAvailableModelsResults(
  results: Array<{ endpoint: string; status: number; data: unknown } | undefined>,
): { endpoint: string; status: number; data: AvailableModelsRaw } {
  const mergedModels: Record<string, unknown> = {};
  let defaultAgentModelId: string | undefined;
  let defaultAgentModel: string | undefined;
  let agentModelSorts: AvailableModelsRaw["agentModelSorts"];
  let lastEndpoint = "";
  let lastStatus = 0;

  for (const result of results) {
    if (
      !result ||
      !isRecord(result.data) ||
      !isRecord(result.data.models) ||
      Object.keys(result.data.models).length === 0 ||
      !Object.values(result.data.models).every(isRecord)
    )
      continue;
    setLastEndpoint(result.endpoint);
    setLastStatus(result.status);
    lastEndpoint = result.endpoint;
    lastStatus = result.status;
    const data = result.data;
    if (isRecord(data) && isRecord(data.models)) {
      Object.assign(mergedModels, data.models);
      registerDiscoveredModelEnums(data.models as Record<string, { model?: unknown }>);
    }
    if (isRecord(data) && typeof data.defaultAgentModelId === "string") {
      defaultAgentModelId = data.defaultAgentModelId;
    }
    if (isRecord(data) && typeof data.defaultAgentModel === "string") {
      defaultAgentModel = data.defaultAgentModel;
    }
    if (isRecord(data) && Array.isArray(data.agentModelSorts)) {
      agentModelSorts = data.agentModelSorts as AvailableModelsRaw["agentModelSorts"];
    }
  }

  if (!lastEndpoint) {
    throw new Error(
      `/v1internal:fetchAvailableModels failed: no endpoint returned a valid non-empty catalog`,
    );
  }

  return {
    endpoint: lastEndpoint,
    status: lastStatus,
    data: {
      models: mergedModels as AvailableModelsRaw["models"],
      defaultAgentModelId,
      defaultAgentModel,
      agentModelSorts,
    },
  };
}

/**
 * Merge fetchAvailableModels across endpoint candidates so daily/sandbox-only
 * models appear alongside production catalog entries.
 */
export async function fetchAvailableModelsCatalog(
  token: string,
  projectId: string,
  signal?: AbortSignal,
): Promise<{ endpoint: string; status: number; data: AvailableModelsRaw }> {
  const results = await Promise.all(
    endpointCandidates().map((endpoint) =>
      fetchAvailableModelsFromEndpoint(endpoint, token, projectId, signal),
    ),
  );
  return mergeAvailableModelsResults(results);
}

async function loadCodeAssistUncached(token: string): Promise<string | undefined> {
  const body = JSON.stringify({
    metadata: {
      ideType: "ANTIGRAVITY",
    },
  });

  for (const endpoint of endpointCandidates()) {
    try {
      const res = await antigravityFetch(`${endpoint}/v1internal:loadCodeAssist`, {
        method: "POST",
        headers: antigravityHeaders(token),
        body,
        signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
      });
      setLastStatus(res.status);
      setLastEndpoint(endpoint);
      if (!res.ok) continue;
      const project = extractProjectId(await res.json());
      if (project) return project;
      return await listCloudAICompanionProjects(token);
    } catch (error) {
      setLastError(safeError(error));
    }
  }
  return undefined;
}

function tokenFingerprint(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Discover project id with a short in-memory LRU cache keyed by a token digest. */
export async function loadCodeAssist(token: string): Promise<string | undefined> {
  const key = tokenFingerprint(token);
  const cached = projectCache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    // Refresh LRU order: delete and re-insert so newest is at the end.
    projectCache.delete(key);
    projectCache.set(key, cached);
    return cached.projectId;
  }

  const projectId = await loadCodeAssistUncached(token);
  projectCache.set(key, { projectId, expiresAt: Date.now() + PROJECT_CACHE_TTL_MS });

  // Evict oldest entry when the cache exceeds 32 entries (O(1) — Map preserves insertion order).
  if (projectCache.size > 32) {
    const oldestKey = projectCache.keys().next().value;
    if (oldestKey !== undefined) projectCache.delete(oldestKey);
  }
  return projectId;
}

export function clearProjectCache(): void {
  projectCache.clear();
}

export function resolveProjectId(opts: {
  token: string;
  credentialProjectId?: string;
  email?: string;
  warmedProject?: string | null;
}): string {
  return (
    antigravityEnv("PROJECT_ID")?.trim() ||
    opts.warmedProject ||
    opts.credentialProjectId ||
    defaultProjectId(opts.email || "antigravity-default")
  );
}

/** Build a diagnostic suffix using the active request bag. */
export function formatRequestDiagnostics(extra: {
  projectId: string;
  runtimeModel: string;
}): string {
  return `endpoint=${getCurrentEndpoint() || "unknown"}, project=${extra.projectId}, runtimeModel=${extra.runtimeModel}, matched=${getCurrentMatchedModelDebug() || "none"}, available=${getCurrentAvailableModels() || "unknown"}`;
}
