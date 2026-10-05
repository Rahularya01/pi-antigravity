import { createHash } from "node:crypto";
import { getModelEnum } from "../models/models.js";

export function antigravityEnv(name: string): string | undefined {
  return process.env[`ANTIGRAVITY_${name}`] || process.env[`NOAGY_${name}`];
}

/**
 * Whether a model-facing extra tool (`google_search`, `generate_image`) is registered.
 * `ANTIGRAVITY_NO_EXTRA_TOOLS=1` disables both; `ANTIGRAVITY_NO_SEARCH_TOOL=1` and
 * `ANTIGRAVITY_NO_IMAGE_TOOL=1` disable one, e.g. to avoid clashing with another search provider.
 */
export function isExtraToolEnabled(tool: "SEARCH" | "IMAGE"): boolean {
  return antigravityEnv("NO_EXTRA_TOOLS") !== "1" && antigravityEnv(`NO_${tool}_TOOL`) !== "1";
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function asString(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

export function sanitizeText(text: unknown): string {
  const str = String(text ?? "");
  const toWellFormed = (str as unknown as { toWellFormed?: () => string }).toWellFormed;
  if (typeof toWellFormed === "function") {
    return toWellFormed.call(str);
  }
  return str.replace(
    /(?:[\uD800-\uDBFF](?![\uDC00-\uDFFF]))|(?:(?<![\uD800-\uDBFF])[\uDC00-\uDFFF])/g,
    "\uFFFD",
  );
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function nowRequestId(): string {
  return antigravityRequestEnvelope("unknown", false).requestId;
}

/** Deterministic RFC 4122 v5 UUID from seed (survives restarts for the same session seed). */
export function stableUuid(seed: string): string {
  const bytes = createHash("sha1").update(seed).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export type AntigravityEnvelopeOptions = {
  isClaude?: boolean;
  isNonGemini?: boolean;
  step?: number;
  lastStepIndex?: string;
  requestIndex?: number;
  userTurnIndex?: number;
  trajectoryId?: string;
  conversationId?: string;
  sessionId?: string;
  lastExecutionId?: string;
};

/** Deterministic signed int64 string for session_id to maintain backend KV cache affinity. */
export function toInt64SessionId(seed?: string): string {
  if (seed?.trim()) {
    const s = seed.trim();
    if (/^-?\d+$/.test(s)) return s;
    const hash = createHash("sha256").update(`antigravity:session:${s}`).digest();
    return String(new DataView(hash.buffer, hash.byteOffset, 8).getBigInt64(0, true));
  }
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return String(new DataView(bytes.buffer, bytes.byteOffset, 8).getBigInt64(0, true));
}

const sessionTrajectoryMap = new Map<
  string,
  { conversationId: string; trajectoryId: string; sessionId: string }
>();

/** Stable conversationId, trajectoryId, and sessionId within a multi-turn conversation session. */
export function resolveSessionTrajectory(
  context?: {
    messages?: Array<{ role?: string; timestamp?: number; content?: unknown }>;
  },
  sessionId?: string,
): { conversationId: string; trajectoryId: string; sessionId: string } {
  if (sessionId?.trim()) {
    const seed = `session:${sessionId.trim()}`;
    let entry = sessionTrajectoryMap.get(seed);
    if (!entry) {
      entry = {
        conversationId: stableUuid(`antigravity:conv:${seed}`),
        trajectoryId: stableUuid(`antigravity:traj:${seed}`),
        sessionId: toInt64SessionId(sessionId),
      };
      sessionTrajectoryMap.set(seed, entry);
      if (sessionTrajectoryMap.size > 64) {
        const oldestKey = sessionTrajectoryMap.keys().next().value;
        if (oldestKey !== undefined) sessionTrajectoryMap.delete(oldestKey);
      }
    }
    return entry;
  }

  const firstMsg = context?.messages?.[0];
  if (!firstMsg) {
    return {
      conversationId: crypto.randomUUID(),
      trajectoryId: crypto.randomUUID(),
      sessionId: toInt64SessionId(),
    };
  }
  const contentSeed =
    typeof firstMsg.content === "string"
      ? firstMsg.content.slice(0, 64)
      : Array.isArray(firstMsg.content)
        ? JSON.stringify(firstMsg.content[0] ?? "").slice(0, 64)
        : "";
  const seed = `${firstMsg.role || "user"}:${firstMsg.timestamp || ""}:${contentSeed}`;
  let entry = sessionTrajectoryMap.get(seed);
  if (!entry) {
    entry = {
      conversationId: stableUuid(`antigravity:conv:${seed}`),
      trajectoryId: stableUuid(`antigravity:traj:${seed}`),
      sessionId: toInt64SessionId(seed),
    };
    sessionTrajectoryMap.set(seed, entry);
    if (sessionTrajectoryMap.size > 64) {
      const oldestKey = sessionTrajectoryMap.keys().next().value;
      if (oldestKey !== undefined) sessionTrajectoryMap.delete(oldestKey);
    }
  }
  return entry;
}

export function clearSessionTrajectoryMap(): void {
  sessionTrajectoryMap.clear();
}

export function antigravityRequestEnvelope(
  wireModelId: string,
  optionsOrIsClaude: boolean | AntigravityEnvelopeOptions = false,
): { requestId: string; sessionId: string; labels: Record<string, string> } {
  const options: AntigravityEnvelopeOptions =
    typeof optionsOrIsClaude === "boolean" ? { isClaude: optionsOrIsClaude } : optionsOrIsClaude;

  const isClaude = Boolean(options.isClaude);
  const isNonGemini = Boolean(options.isNonGemini || isClaude);
  const step = Math.max(1, options.step ?? 1);
  const lastStepIndex = options.lastStepIndex ?? String(Math.max(0, step - 1));
  const requestIndex = options.requestIndex ?? options.userTurnIndex ?? Math.max(0, step - 1);
  const agentId = options.conversationId || crypto.randomUUID();
  const trajectoryId = options.trajectoryId || crypto.randomUUID();
  const sessionId = options.sessionId || toInt64SessionId();

  const claudeLabel = isClaude ? "true" : "false";
  const nonGeminiLabel = isNonGemini ? "true" : "false";

  const labels: Record<string, string> = {
    last_step_index: lastStepIndex,
    request_id: `${trajectoryId}-${requestIndex}`,
    trajectory_id: trajectoryId,
    used_claude: claudeLabel,
    used_claude_conservative: claudeLabel,
    used_non_gemini_model: nonGeminiLabel,
  };

  const modelEnum = getModelEnum(wireModelId);
  if (modelEnum) {
    labels.model_enum = modelEnum;
  }

  // Pure agy CLI wire alignment: last_execution_id is the execution ID of the previous turn.
  // It is only present on subsequent turns (step > 1), never on the initial turn (step <= 1).
  if (step > 1) {
    labels.last_execution_id =
      options.lastExecutionId || stableUuid(`antigravity:exec:${trajectoryId}:${step - 1}`);
  }

  return {
    requestId: `agent/${agentId}/${Date.now()}/${trajectoryId}/${step}`,
    sessionId,
    labels,
  };
}
