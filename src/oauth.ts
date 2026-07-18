import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { OAuthCredentials, OAuthLoginCallbacks } from "@earendil-works/pi-ai";
import { Platform } from "./enums.js";
import type {
  AntigravityOAuthCredentials,
  AntigravityApiKey,
  DynamicModelInfo,
  CallbackServer,
} from "./types.js";

export const DEFAULT_ENDPOINT = "https://cloudcode-pa.googleapis.com";
export const ENDPOINT_FALLBACKS = [
  DEFAULT_ENDPOINT,
  "https://daily-cloudcode-pa.sandbox.googleapis.com",
];
export const REDIRECT_URI = "http://localhost:51121/oauth-callback";
export const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const TOKEN_URL = "https://oauth2.googleapis.com/token";
export const SCOPES = [
  "https://www.googleapis.com/auth/cloud-platform",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
  "https://www.googleapis.com/auth/cclog",
  "https://www.googleapis.com/auth/experimentsandconfigs",
];

export function antigravityEnv(name: string): string | undefined {
  return process.env[`ANTIGRAVITY_${name}`] || process.env[`NOAGY_${name}`];
}

export function stableProjectId(seed: string): string {
  const bytes = createHash("sha1").update(`antigravity:${seed}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export const CALLBACK_HOST = antigravityEnv("CALLBACK_HOST") || "127.0.0.1";
export const DEFAULT_PROJECT_ID = antigravityEnv("PROJECT_ID") || stableProjectId(process.cwd());
export const CLIENT_ID =
  antigravityEnv("CLIENT_ID") ||
  Buffer.from(
    "MTA3MTAwNjA2MDU5MS10bWhzc2luMmgyMWxjcmUyMzV2dG9sb2poNGc0MDNlc" +
      "C5hcHBzLmdvb2dsZXVzZXJjb250ZW50LmNvbQ==",
    "base64",
  ).toString("utf8");
export const CLIENT_SECRET =
  antigravityEnv("CLIENT_SECRET") ||
  Buffer.from("R09DU1BYLUs1OEZXUjQ" + "4NkxkTEoxbUxCOHNYQzR6NnFEQWY=", "base64").toString("utf8");

// Shared diagnostics (never store secrets here)
export let lastStatus: number | undefined;
export let lastEndpoint: string | undefined;
export let lastError: string | undefined;
export let lastProjectId: string | undefined;
export let lastResolvedRuntimeModel: string | undefined;
export let lastAvailableModels: string | undefined;
export let lastMatchedModelDebug: string | undefined;

export function setLastStatus(status: number | undefined): void {
  lastStatus = status;
}
export function setLastEndpoint(endpoint: string | undefined): void {
  lastEndpoint = endpoint;
}
export function setLastError(error: string | undefined): void {
  lastError = error;
}
export function setLastProjectId(projectId: string | undefined): void {
  lastProjectId = projectId;
}
export function setLastResolvedRuntimeModel(model: string | undefined): void {
  lastResolvedRuntimeModel = model;
}
export function setLastAvailableModels(models: string | undefined): void {
  lastAvailableModels = models;
}
export function setLastMatchedModelDebug(debug: string | undefined): void {
  lastMatchedModelDebug = debug;
}

export function nowRequestId(): string {
  return `antigravity-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
}

export function endpointCandidates(): string[] {
  const explicit = antigravityEnv("BASE_URL")?.trim();
  return explicit ? [explicit] : ENDPOINT_FALLBACKS;
}

export function safeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function sanitizeText(text: unknown): string {
  return String(text ?? "").replace(/[\uD800-\uDFFF]/g, "\uFFFD");
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
    // Match community-verified Antigravity client fingerprints used by Cloud Code Assist.
    "User-Agent": antigravityEnv("USER_AGENT") || "antigravity/1.15.8 darwin/arm64",
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

function base64Url(buffer: Buffer): string {
  return buffer.toString("base64url");
}

function generatePKCE(): { verifier: string; challenge: string } {
  const verifier = base64Url(randomBytes(32));
  const challenge = base64Url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

async function getUserEmail(token: string): Promise<string | undefined> {
  try {
    const res = await fetch("https://www.googleapis.com/oauth2/v1/userinfo?alt=json", {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return undefined;
    const data = (await res.json()) as { email?: string };
    return data.email;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
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
      lastStatus = res.status;
      lastEndpoint = endpoint;
      if (!res.ok) continue;
      return extractProjectId(await res.json());
    } catch (error) {
      lastError = safeError(error);
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
  else if (req === "gemini-3.1-pro-high") targetRegex = /gemini[- ]3\.1[- ]pro \(high\)/i;
  else if (req.includes("gemini-2.5-pro")) targetRegex = /gemini[- ]2\.5[- ]pro/i;
  else if (req.includes("gemini-2.5-flash")) targetRegex = /gemini[- ]2\.5[- ]flash/i;
  else targetRegex = new RegExp(req.replace(/-/g, ".*"), "i");

  if (typeof value === "string") return targetRegex.test(value) ? { id: value } : undefined;
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
      lastMatchedModelDebug = summarizeModelCandidate(value);
      const experiments = Array.isArray(value.modelExperiments)
        ? value.modelExperiments.filter((item): item is string => typeof item === "string")
        : undefined;
      return {
        id: String(value.modelId ?? value.id ?? value.model ?? label),
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
        lastStatus = res.status;
        lastEndpoint = endpoint;
        if (!res.ok) continue;
        const data: unknown = await res.json();
        const labels = [...new Set(collectModelLabels(data))].slice(0, 12);
        lastAvailableModels = labels.join(",");
        return findDynamicModel(data, requestedRuntimeModel);
      } catch (error) {
        lastError = safeError(error);
      }
    }
  }
  return undefined;
}

export async function loadCodeAssist(token: string): Promise<string | undefined> {
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
      lastStatus = res.status;
      lastEndpoint = endpoint;
      if (!res.ok) continue;
      const project = extractProjectId(await res.json());
      if (project) return project;
      return await listCloudAICompanionProjects(token);
    } catch (error) {
      lastError = safeError(error);
    }
  }
  return undefined;
}

function startCallbackServer(): Promise<CallbackServer> {
  return new Promise((resolve, reject) => {
    let resolveCode!: (value: { code: string; state: string }) => void;
    let rejectCode!: (error: Error) => void;
    const codePromise = new Promise<{ code: string; state: string }>((res, rej) => {
      resolveCode = res;
      rejectCode = rej;
    });

    const server = createServer((req, res) => {
      const url = new URL(req.url || "", REDIRECT_URI);
      if (url.pathname !== "/oauth-callback") {
        res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
        res.end("Antigravity OAuth callback route not found.");
        return;
      }

      const error = url.searchParams.get("error");
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      if (error) {
        res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
        res.end(`Antigravity authentication failed: ${error}`);
        rejectCode(new Error(`OAuth error: ${error}`));
        return;
      }
      if (!code || !state) {
        res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
        res.end("Antigravity authentication failed: missing code or state.");
        rejectCode(new Error("Missing code or state in OAuth callback"));
        return;
      }

      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end("Antigravity authentication complete. You can close this window and return to Pi.");
      resolveCode({ code, state });
    });

    server.on("error", reject);
    server.listen(51121, CALLBACK_HOST, () => resolve({ server, waitForCode: () => codePromise }));
  });
}

function credentialProjectId(credentials: OAuthCredentials): string | undefined {
  return typeof credentials.projectId === "string" ? credentials.projectId : undefined;
}

export async function loginAntigravity(
  callbacks: OAuthLoginCallbacks,
): Promise<AntigravityOAuthCredentials> {
  const { verifier, challenge } = generatePKCE();
  const { server, waitForCode } = await startCallbackServer();
  try {
    const authParams = new URLSearchParams({
      client_id: CLIENT_ID,
      response_type: "code",
      redirect_uri: REDIRECT_URI,
      scope: SCOPES.join(" "),
      code_challenge: challenge,
      code_challenge_method: "S256",
      state: verifier,
      access_type: "offline",
      prompt: "consent",
    });
    callbacks.onAuth({
      url: `${AUTH_URL}?${authParams.toString()}`,
      instructions: "Complete Google sign-in. Pi will capture the local callback.",
    });

    const { code, state } = await waitForCode();
    if (state !== verifier) throw new Error("OAuth state mismatch");

    const tokenResponse = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        code,
        grant_type: "authorization_code",
        redirect_uri: REDIRECT_URI,
        code_verifier: verifier,
      }).toString(),
    });
    if (!tokenResponse.ok) {
      throw new Error(`Token exchange failed: ${await tokenResponse.text()}`);
    }
    const tokenData = (await tokenResponse.json()) as {
      access_token: string;
      refresh_token?: string;
      expires_in: number;
    };
    if (!tokenData.refresh_token) {
      throw new Error(
        "No refresh token received. Re-run /login antigravity and allow offline access.",
      );
    }

    const [email, discoveredProject] = await Promise.all([
      getUserEmail(tokenData.access_token),
      loadCodeAssist(tokenData.access_token),
    ]);
    return {
      refresh: tokenData.refresh_token,
      access: tokenData.access_token,
      expires: Date.now() + tokenData.expires_in * 1000 - 5 * 60 * 1000,
      projectId: discoveredProject || DEFAULT_PROJECT_ID,
      email,
    };
  } finally {
    server.close();
  }
}

export async function refreshAntigravityToken(
  credentials: OAuthCredentials,
): Promise<AntigravityOAuthCredentials> {
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      refresh_token: credentials.refresh,
      grant_type: "refresh_token",
    }).toString(),
  });
  if (!response.ok) {
    throw new Error(`Antigravity token refresh failed: ${await response.text()}`);
  }
  const data = (await response.json()) as {
    access_token: string;
    expires_in: number;
    refresh_token?: string;
  };
  const discoveredProject = await loadCodeAssist(data.access_token);
  return {
    ...credentials,
    refresh: data.refresh_token || credentials.refresh,
    access: data.access_token,
    expires: Date.now() + data.expires_in * 1000 - 5 * 60 * 1000,
    projectId: discoveredProject || credentialProjectId(credentials) || DEFAULT_PROJECT_ID,
  };
}

export function getApiKey(credentials: OAuthCredentials): string {
  return JSON.stringify({
    token: credentials.access,
    projectId: credentialProjectId(credentials) || DEFAULT_PROJECT_ID,
  });
}

export type { OAuthCredentials, OAuthLoginCallbacks } from "@earendil-works/pi-ai";
