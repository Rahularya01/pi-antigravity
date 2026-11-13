/**
 * Gemini Enterprise routing.
 *
 * Consumer prompts stay on cloudcode-pa. A regional enterprise license (error
 * #3501) must not fall back there: Google documents separate Business AI Code
 * hosts, and a consumer URL both fails the license check and leaves the
 * configured region. Inference is sent only to the host for the selected
 * location, using the enterprise generate path:
 *   /v1beta/projects/{project}/locations/{location}:streamGenerateContent
 * The body keeps the Gemini request fields and names the license tier. Unknown
 * consumer envelope fields are dropped because the enterprise API rejects them.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AntigravityGenerateRequest } from "../types/types.js";
import { antigravityEnv, isRecord } from "../utils/util.js";

const LOCATIONS = ["global", "us", "eu"] as const;
export type EnterpriseLocation = (typeof LOCATIONS)[number];

const PROJECT_ID = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
const USER_TIER = /^[a-z0-9][a-z0-9._-]{0,80}$/;

export type EnterpriseTarget = {
  location: EnterpriseLocation;
  projectId: string;
  userTier: string;
  host: string;
};

export function enterpriseHost(location: EnterpriseLocation): string {
  if (location === "global") return "https://businessaicode.googleapis.com";
  return `https://businessaicode.${location}.rep.googleapis.com`;
}

export function enterpriseStreamUrl(target: EnterpriseTarget): string {
  const project = encodeURIComponent(target.projectId);
  return `${target.host}/v1beta/projects/${project}/locations/${target.location}:streamGenerateContent?alt=sse`;
}

function truthy(value: string | undefined): boolean {
  return !!value && ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function stringField(record: Record<string, unknown> | undefined, key: string): string {
  const value = record?.[key];
  return typeof value === "string" ? value.trim() : "";
}

function readCliSettings(): Record<string, unknown> | undefined {
  const path = join(homedir(), ".gemini", "antigravity-cli", "settings.json");
  if (!existsSync(path)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function licenseRecord(
  settings: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  const license = settings?.selectedLicense ?? settings?.license;
  return isRecord(license) ? license : undefined;
}

/**
 * Resolve an explicit enterprise target, or undefined for the consumer path.
 * `eu` / `us` (and `ANTIGRAVITY_ENTERPRISE=1`) never silently use cloudcode-pa.
 */
export function resolveEnterpriseTarget(): EnterpriseTarget | undefined {
  const settings = readCliSettings();
  const license = licenseRecord(settings);
  const forced = truthy(antigravityEnv("ENTERPRISE"));
  const locationRaw = (
    antigravityEnv("LOCATION") ||
    stringField(settings, "location") ||
    stringField(license, "location") ||
    (forced ? process.env.GOOGLE_CLOUD_LOCATION || "global" : "")
  )
    .trim()
    .toLowerCase();

  if (locationRaw && !LOCATIONS.includes(locationRaw as EnterpriseLocation)) {
    throw new Error("ANTIGRAVITY_LOCATION must be global, us, or eu. The prompt was not sent.");
  }

  const regional = locationRaw === "eu" || locationRaw === "us";
  if (!regional && !forced) return undefined;

  const location = (locationRaw || "global") as EnterpriseLocation;
  const projectId =
    antigravityEnv("ENTERPRISE_PROJECT")?.trim() ||
    stringField(settings, "project") ||
    stringField(settings, "projectId") ||
    stringField(settings, "licenseProject") ||
    stringField(license, "project") ||
    stringField(license, "projectId");
  const userTier =
    antigravityEnv("USER_TIER")?.trim() ||
    stringField(settings, "userTier") ||
    stringField(settings, "entitlementTier") ||
    stringField(license, "userTier") ||
    stringField(license, "tier");

  if (!PROJECT_ID.test(projectId)) {
    throw new Error(
      "Gemini Enterprise routing needs ANTIGRAVITY_ENTERPRISE_PROJECT set to the license's Google Cloud project id. Refusing to send this prompt to the consumer endpoint.",
    );
  }
  if (!USER_TIER.test(userTier)) {
    throw new Error(
      "Gemini Enterprise routing needs ANTIGRAVITY_USER_TIER from the selected license (for example the tier id shown by agy). Refusing to send this prompt to the consumer endpoint.",
    );
  }

  return { location, projectId, userTier, host: enterpriseHost(location) };
}

export function describeEnterpriseRouting(): string {
  try {
    const target = resolveEnterpriseTarget();
    if (!target) return "consumer";
    return `enterprise location=${target.location} host=${target.host} project=${target.projectId}`;
  } catch (error) {
    const message = error instanceof Error ? error.message : "invalid enterprise configuration";
    return `enterprise misconfigured (${message})`;
  }
}

/** Allowlisted enterprise generate body. Drops the consumer envelope. */
export function toEnterpriseGenerateBody(
  payload: AntigravityGenerateRequest,
  target: EnterpriseTarget,
): Record<string, unknown> {
  const request = payload.request;
  const body: Record<string, unknown> = {
    contents: request.contents,
    aicode: { experience: payload.model },
    entitlement: { userTier: target.userTier },
  };
  if (request.systemInstruction) body.systemInstruction = request.systemInstruction;
  if (request.tools) body.tools = request.tools;
  if (request.toolConfig) body.toolConfig = request.toolConfig;
  if (request.generationConfig) body.generationConfig = request.generationConfig;
  if (request.labels) body.labels = request.labels;
  return body;
}
