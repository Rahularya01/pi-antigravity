import { createHash } from "node:crypto";
import { Platform } from "../types/enums.js";
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
import type { AntigravityApiKey, DynamicModelInfo } from "../types/types.js";
import { antigravityEnv, asString, escapeRegExp, isRecord } from "../utils/util.js";

export const DEFAULT_ENDPOINT = "https://cloudcode-pa.googleapis.com";
export const ENDPOINT_FALLBACKS = [
  DEFAULT_ENDPOINT,
  "https://daily-cloudcode-pa.sandbox.googleapis.com",
];

const PROJECT_CACHE_TTL_MS = 5 * 60 * 1000;
const projectCache = new Map<string, { projectId: string | undefined; expiresAt: number }>();

/** UUID-shaped stable id from a seed (account email preferred over cwd). */
export function stableProjectId(seed: string): string {
  const bytes = createHash("sha1").update(`antigravity:${seed}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
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

function defaultUserAgent(): string {
  const os =
    process.platform === "darwin" ? "darwin" : process.platform === "win32" ? "windows" : "linux";
  const arch = process.arch === "x64" ? "amd64" : process.arch;
  return `antigravity/1.15.8 ${os}/${arch}`;
}

export function antigravityHeaders(token: string): Record<string, string> {
  const platform =
    process.platform === "darwin"
      ? Platform.Macos
      : process.platform === "win32"
        ? Platform.Windows
        : Platform.Linux;
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    Accept: "text/event-stream",
    "User-Agent": antigravityEnv("USER_AGENT") || defaultUserAgent(),
    "X-Goog-Api-Client": "google-cloud-sdk vscode_cloudshelleditor/0.1",
    "Client-Metadata": JSON.stringify({
      ideType: "ANTIGRAVITY",
      platform,
      pluginType: "GEMINI",
    }),
  };
}

export function jsonOrTextError(text: string): string {
  try {
    const parsed = JSON.parse(text) as {
      error?: { message?: string; status?: string; code?: number };
    };
    if (parsed.error?.message) return parsed.error.message;
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
    const parsed = JSON.parse(apiKeyRaw) as Partial<AntigravityApiKey>;
    if (!parsed.token || !parsed.projectId) throw new Error("missing token or projectId");
    return { token: parsed.token, projectId: parsed.projectId };
  } catch (error) {
    throw new Error(
      `Invalid Antigravity credentials. Run /login antigravity. (${safeError(error)})`,
      { cause: error },
    );
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
      const res = await fetch(`${endpoint}/v1internal:listCloudAICompanionProjects`, {
        method: "POST",
        headers: antigravityHeaders(token),
        body: JSON.stringify({}),
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

function findDynamicModel(value: unknown, requestedId: string): DynamicModelInfo | undefined {
  if (!value) return undefined;

  let targetRegex: RegExp;
  const req = requestedId.toLowerCase();
  if (req === "gemini-3.5-flash-low") targetRegex = /gemini[- ]3\.5[- ]flash \(low\)/i;
  else if (req === "gemini-3.5-flash-medium") targetRegex = /gemini[- ]3\.5[- ]flash \(medium\)/i;
  else if (req === "gemini-3.5-flash-high") targetRegex = /gemini[- ]3\.5[- ]flash \(high\)/i;
  else if (req.includes("claude-opus-4-6")) targetRegex = /claude.*opus.*4\.6/i;
  else if (req.includes("claude-sonnet-4-6")) targetRegex = /claude.*sonnet.*4\.6/i;
  else if (req.includes("gpt-oss-120b")) targetRegex = /gpt.*oss.*120b/i;
  else if (req === "gemini-3.1-pro-low") targetRegex = /gemini[- ]3\.1[- ]pro \(low\)/i;
  else if (req === "gemini-3.1-pro-high" || req === "gemini-pro-agent")
    targetRegex = /gemini[- ]3\.1[- ]pro \(high\)/i;
  else {
    const escaped = escapeRegExp(req).replace(/\\-/g, "[- ]");
    targetRegex = new RegExp(escaped, "i");
  }

  if (typeof value === "string") {
    // Prefer exact runtime ids over display labels (labels often contain spaces).
    return targetRegex.test(value) && !/\s/.test(value) ? { id: value } : undefined;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findDynamicModel(item, requestedId);
      if (found) return found;
    }
    return undefined;
  }
  if (isRecord(value)) {
    const label =
      value.label ?? value.displayName ?? value.name ?? value.modelId ?? value.id ?? value.model;
    if (typeof label === "string" && targetRegex.test(label)) {
      const runtimeId =
        asString(value.modelId) ?? asString(value.id) ?? asString(value.model) ?? undefined;
      // Only accept ids that look like runtime model ids (no spaces / display names).
      if (!runtimeId || /\s/.test(runtimeId)) return undefined;
      setLastMatchedModelDebug(summarizeModelCandidate(value));
      const experiments = Array.isArray(value.modelExperiments)
        ? value.modelExperiments.filter((item): item is string => typeof item === "string")
        : undefined;
      return {
        id: runtimeId,
        experiments,
        apiProvider: asString(value.apiProvider),
        modelProvider: asString(value.modelProvider),
      };
    }
    for (const nested of Object.values(value)) {
      if (nested && typeof nested === "object") {
        const found = findDynamicModel(nested, requestedId);
        if (found) return found;
      }
    }
  }
  return undefined;
}

export async function fetchAvailableRuntimeModel(
  token: string,
  projectId: string,
  requestedRuntimeModel: string,
): Promise<DynamicModelInfo | undefined> {
  const bodies = [{}, { cloudaicompanionProject: projectId }, { project: projectId }];
  for (const endpoint of endpointCandidates()) {
    for (const candidateBody of bodies) {
      try {
        const res = await fetch(`${endpoint}/v1internal:fetchAvailableModels`, {
          method: "POST",
          headers: antigravityHeaders(token),
          body: JSON.stringify(candidateBody),
        });
        setLastStatus(res.status);
        setLastEndpoint(endpoint);
        if (!res.ok) continue;
        const data: unknown = await res.json();
        const labels = [...new Set(collectModelLabels(data))].slice(0, 12);
        setLastAvailableModels(labels.join(","));
        return findDynamicModel(data, requestedRuntimeModel);
      } catch (error) {
        setLastError(safeError(error));
      }
    }
  }
  return undefined;
}

async function loadCodeAssistUncached(token: string): Promise<string | undefined> {
  const body = JSON.stringify({
    metadata: {
      ideType: "ANTIGRAVITY",
      platform: "PLATFORM_UNSPECIFIED",
      pluginType: "GEMINI",
    },
  });

  for (const endpoint of endpointCandidates()) {
    try {
      const res = await fetch(`${endpoint}/v1internal:loadCodeAssist`, {
        method: "POST",
        headers: antigravityHeaders(token),
        body,
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

/** Discover project id with a short in-memory cache keyed by access token. */
export async function loadCodeAssist(token: string): Promise<string | undefined> {
  const cached = projectCache.get(token);
  if (cached && cached.expiresAt > Date.now()) return cached.projectId;

  const projectId = await loadCodeAssistUncached(token);
  projectCache.set(token, { projectId, expiresAt: Date.now() + PROJECT_CACHE_TTL_MS });

  // Bound memory if tokens rotate frequently.
  if (projectCache.size > 32) {
    const now = Date.now();
    for (const [key, entry] of projectCache) {
      if (entry.expiresAt <= now) projectCache.delete(key);
    }
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
