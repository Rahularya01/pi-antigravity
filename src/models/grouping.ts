import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { ThinkingEffort } from "../types/enums.js";
import type { AntigravityRouting, ModelInfoRaw } from "../types/types.js";
import { isRecord } from "../utils/util.js";
import { getAntigravityModelCost } from "./models.js";

export type AntigravityCatalog = {
  models: ProviderModelConfig[];
  routing: Record<string, AntigravityRouting>;
};

type ThinkingLevel = ThinkingEffort;

type RuntimeGroup = {
  publicId: string;
  variants: Partial<Record<ThinkingLevel, string>>;
  unsuffixed?: string;
  displayNames: string[];
  /** Catalog capability: true/false when advertised, undefined when omitted. */
  supportsThinking?: boolean;
  supportsImages?: boolean;
  contextWindow?: number;
  maxOutputTokens?: number;
};

const THINKING_SUFFIXES: Array<{ suffix: string; level: ThinkingLevel }> = [
  { suffix: "extra-low", level: ThinkingEffort.Low },
  { suffix: "extra-high", level: ThinkingEffort.Xhigh },
  { suffix: "thinking", level: ThinkingEffort.High },
  { suffix: "minimal", level: ThinkingEffort.Minimal },
  { suffix: "medium", level: ThinkingEffort.Medium },
  { suffix: "high", level: ThinkingEffort.High },
  { suffix: "low", level: ThinkingEffort.Low },
];

const DISPLAY_LEVELS: Array<{ pattern: RegExp; level: ThinkingLevel }> = [
  { pattern: /\(\s*extra\s*low\s*\)/i, level: ThinkingEffort.Low },
  { pattern: /\(\s*extra\s*high\s*\)/i, level: ThinkingEffort.Xhigh },
  { pattern: /\(\s*thinking\s*\)/i, level: ThinkingEffort.High },
  { pattern: /\(\s*minimal\s*\)/i, level: ThinkingEffort.Minimal },
  { pattern: /\(\s*medium\s*\)/i, level: ThinkingEffort.Medium },
  { pattern: /\(\s*high\s*\)/i, level: ThinkingEffort.High },
  { pattern: /\(\s*low\s*\)/i, level: ThinkingEffort.Low },
];

const PI_LEVELS = [
  ThinkingEffort.Off,
  ThinkingEffort.Minimal,
  ThinkingEffort.Low,
  ThinkingEffort.Medium,
  ThinkingEffort.High,
  ThinkingEffort.Xhigh,
  "max",
] as const;

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

export function isSelectableRuntimeModelId(id: string, info?: ModelInfoRaw): boolean {
  if (!/^[a-z0-9][a-z0-9_.-]*$/i.test(id) || /^MODEL_/i.test(id)) return false;
  if (/^(chat_|tab_)/i.test(id)) return false;
  if (/image/i.test(id) || /image/i.test(modelDisplayName(info) ?? "")) return false;
  if (info?.isInternal === true || info?.apiProvider === "API_PROVIDER_INTERNAL") return false;
  return true;
}

export function resolvedCatalog(
  discovered: AntigravityCatalog | undefined,
  current: AntigravityCatalog,
): AntigravityCatalog {
  if (discovered && discovered.models.length > 0) return discovered;
  return current;
}

export function extractRecommendedModelIds(agentModelSorts: unknown): Set<string> | undefined {
  if (!Array.isArray(agentModelSorts) || agentModelSorts.length === 0) return undefined;
  const ids = new Set<string>();
  for (const sort of agentModelSorts) {
    if (!isRecord(sort)) continue;
    const groups = Array.isArray(sort.groups) ? sort.groups : [];
    for (const group of groups) {
      if (!isRecord(group) || !Array.isArray(group.modelIds)) continue;
      for (const id of group.modelIds) {
        if (typeof id === "string" && id) ids.add(id);
      }
    }
  }
  return ids.size > 0 ? ids : undefined;
}

export function buildAntigravityCatalog(
  rawModels: Record<string, ModelInfoRaw>,
  fallback: AntigravityCatalog,
  agentModelSorts?: unknown,
): AntigravityCatalog {
  const recommendedIds = extractRecommendedModelIds(agentModelSorts);

  function collectGroups(filterIds?: Set<string>): Map<string, RuntimeGroup> {
    const collected = new Map<string, RuntimeGroup>();

    for (const [runtimeId, info] of Object.entries(rawModels)) {
      if (!isSelectableRuntimeModelId(runtimeId, info)) continue;
      if (info?.isInternal) continue;
      if (filterIds && !filterIds.has(runtimeId)) continue;

      const displayName = modelDisplayName(info);
      if (runtimeId.endsWith("-tiered")) {
        const baseId = runtimeId.slice(0, -"-tiered".length);
        const group = ensureGroup(collected, baseId);
        absorbMetadata(group, info, displayName);
        if (!group.unsuffixed) group.unsuffixed = runtimeId;
        continue;
      }

      const suffix = parseThinkingSuffix(runtimeId);
      const publicId = suffix?.baseId ?? runtimeId;
      const group = ensureGroup(collected, publicId);
      absorbMetadata(group, info, displayName);

      const level = levelFromDisplayName(displayName) ?? suffix?.level;
      if (level) group.variants[level] = runtimeId;
      else group.unsuffixed = runtimeId;
    }

    mergeAgentSingletons(collected);
    return collected;
  }

  let groups = collectGroups(recommendedIds);
  if (groups.size === 0 && recommendedIds) {
    groups = collectGroups();
  }

  if (groups.size === 0) throw new Error("Antigravity catalog contains no supported chat models");

  const models: ProviderModelConfig[] = [];
  const routing: Record<string, AntigravityRouting> = {};

  for (const group of groups.values()) {
    const synthesized = synthesizeModel(group, fallback.models);
    models.push(synthesized.model);
    routing[group.publicId] = synthesized.routing;
  }

  models.sort(comparePublicModels);
  return { models, routing };
}

function positiveTokenLimit(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function ensureGroup(groups: Map<string, RuntimeGroup>, publicId: string): RuntimeGroup {
  const existing = groups.get(publicId);
  if (existing) return existing;
  const created: RuntimeGroup = {
    publicId,
    variants: {},
    displayNames: [],
  };
  groups.set(publicId, created);
  return created;
}

function absorbMetadata(
  group: RuntimeGroup,
  info: ModelInfoRaw | undefined,
  displayName: string | undefined,
): void {
  if (displayName) group.displayNames.push(displayName);
  // A public model can route to any variant. Advertise the smallest supplied
  // limit so every route remains within the server's advertised capabilities.
  const contextWindow = positiveTokenLimit(info?.maxTokens);
  const maxOutputTokens = positiveTokenLimit(info?.maxOutputTokens);
  if (contextWindow !== undefined) {
    group.contextWindow = Math.min(group.contextWindow ?? contextWindow, contextWindow);
  }
  if (maxOutputTokens !== undefined) {
    group.maxOutputTokens = Math.min(group.maxOutputTokens ?? maxOutputTokens, maxOutputTokens);
  }
  if (info?.supportsThinking === true) group.supportsThinking = true;
  else if (info?.supportsThinking === false && group.supportsThinking !== true) {
    group.supportsThinking = false;
  }
  if (info?.supportsImages === false) group.supportsImages = false;
  else if (info?.supportsImages === true && group.supportsImages === undefined) {
    group.supportsImages = true;
  }
}

function mergeAgentSingletons(groups: Map<string, RuntimeGroup>): void {
  for (const [publicId, group] of [...groups.entries()]) {
    if (!publicId.endsWith("-agent") || group.supportsThinking === false) continue;
    const runtimeIds = [group.unsuffixed, ...Object.values(group.variants)].filter(
      (id): id is string => id !== undefined,
    );
    if (runtimeIds.length !== 1) continue;
    const [runtimeId] = runtimeIds;
    const family = displayFamily(group.displayNames[0]);
    if (!family) continue;
    const target = [...groups.values()].find(
      (candidate) =>
        candidate.publicId !== publicId &&
        candidate.displayNames.some((name) => displayFamily(name) === family),
    );
    if (!target) continue;
    const level =
      (Object.keys(group.variants) as ThinkingLevel[]).find(
        (candidate) => group.variants[candidate] === runtimeId,
      ) ?? levelFromDisplayName(group.displayNames[0]);
    if (!level || target.variants[level]) continue;
    target.variants[level] = runtimeId;
    absorbMetadata(
      target,
      {
        supportsThinking: group.supportsThinking,
        supportsImages: group.supportsImages,
        maxTokens: group.contextWindow,
        maxOutputTokens: group.maxOutputTokens,
      },
      group.displayNames[0],
    );
    groups.delete(publicId);
  }
}

function parseThinkingSuffix(
  runtimeId: string,
): { baseId: string; level: ThinkingLevel } | undefined {
  const lower = runtimeId.toLowerCase();
  for (const { suffix, level } of THINKING_SUFFIXES) {
    if (lower.endsWith(`-${suffix}`)) {
      return { baseId: runtimeId.slice(0, -(suffix.length + 1)), level };
    }
  }
  return undefined;
}

function levelFromDisplayName(displayName: string | undefined): ThinkingLevel | undefined {
  if (!displayName) return undefined;
  for (const { pattern, level } of DISPLAY_LEVELS) {
    if (pattern.test(displayName)) return level;
  }
  return undefined;
}

function modelDisplayName(info: ModelInfoRaw | undefined): string | undefined {
  if (!info) return undefined;
  if (typeof info.displayName === "string" && info.displayName) return info.displayName;
  if (typeof info.label === "string" && info.label) return info.label;
  if (typeof info.modelName === "string" && info.modelName) return info.modelName;
  return undefined;
}

function displayFamily(displayName: string | undefined): string | undefined {
  if (!displayName) return undefined;
  return displayName
    .replace(/\s*\((?:extra\s*low|extra\s*high|low|medium|high|minimal|thinking)\)\s*$/i, "")
    .trim()
    .toLowerCase();
}

function synthesizeModel(
  group: RuntimeGroup,
  fallbackModels: ProviderModelConfig[],
): { model: ProviderModelConfig; routing: AntigravityRouting } {
  const template = familyTemplate(group.publicId, fallbackModels);
  const advertisedLevels = advertisedThinkingLevels(group);
  const routing = routingFromVariants(group.publicId, group.variants, group.unsuffixed);
  const supportsImages = group.supportsImages ?? template?.input.includes("image") ?? true;
  const reasoning =
    group.supportsThinking === false
      ? false
      : advertisedLevels.size > 0 ||
        group.supportsThinking === true ||
        (group.supportsThinking === undefined && Boolean(template?.reasoning));
  return {
    model: {
      id: group.publicId,
      name: publicModelName(group),
      reasoning,
      thinkingLevelMap: reasoning ? thinkingLevelMapFromLevels(advertisedLevels) : undefined,
      input: supportsImages ? ["text", "image"] : ["text"],
      // Prefer this model's own published price over the family template's, so a
      // newly discovered Flash variant is not billed at another Flash's rate.
      cost: getAntigravityModelCost(group.publicId) ?? template?.cost ?? ZERO_COST,
      contextWindow: group.contextWindow ?? template?.contextWindow ?? 128000,
      maxTokens: group.maxOutputTokens ?? template?.maxTokens ?? 8192,
    },
    routing,
  };
}

function advertisedThinkingLevels(group: RuntimeGroup): Set<string> {
  // An explicit denial overrides levels inferred from display names or suffixes.
  if (group.supportsThinking === false) return new Set();
  const levels = new Set(Object.keys(group.variants));
  if (levels.size > 0) return levels;
  if (group.supportsThinking === true) {
    levels.add(ThinkingEffort.High);
  }
  return levels;
}

function routingFromVariants(
  publicId: string,
  variants: Partial<Record<ThinkingLevel, string>>,
  unsuffixed?: string,
): AntigravityRouting {
  const defaultRequestId =
    variants[ThinkingEffort.Low] ??
    variants[ThinkingEffort.Minimal] ??
    variants[ThinkingEffort.Medium] ??
    variants[ThinkingEffort.High] ??
    unsuffixed ??
    publicId;

  const pick = (...keys: ThinkingLevel[]): string => {
    for (const key of keys) {
      const id = variants[key];
      if (id) return id;
    }
    return unsuffixed ?? defaultRequestId;
  };

  return {
    off: pick(
      ThinkingEffort.Low,
      ThinkingEffort.Minimal,
      ThinkingEffort.Medium,
      ThinkingEffort.High,
    ),
    routing: {
      minimal: pick(
        ThinkingEffort.Minimal,
        ThinkingEffort.Low,
        ThinkingEffort.Medium,
        ThinkingEffort.High,
      ),
      low: pick(
        ThinkingEffort.Low,
        ThinkingEffort.Minimal,
        ThinkingEffort.Medium,
        ThinkingEffort.High,
      ),
      medium: pick(
        ThinkingEffort.Medium,
        ThinkingEffort.Low,
        ThinkingEffort.High,
        ThinkingEffort.Minimal,
      ),
      high: pick(
        ThinkingEffort.High,
        ThinkingEffort.Medium,
        ThinkingEffort.Low,
        ThinkingEffort.Minimal,
      ),
      xhigh: pick(
        ThinkingEffort.Xhigh,
        ThinkingEffort.High,
        ThinkingEffort.Medium,
        ThinkingEffort.Low,
      ),
    },
    defaultRequestId,
  };
}

function thinkingLevelMapFromLevels(levels: Set<string>): ProviderModelConfig["thinkingLevelMap"] {
  const map: NonNullable<ProviderModelConfig["thinkingLevelMap"]> = {};
  for (const level of PI_LEVELS) {
    map[level] = levels.has(level) ? level : null;
  }
  return map;
}

function familyTemplate(
  publicId: string,
  fallbackModels: ProviderModelConfig[],
): ProviderModelConfig | undefined {
  if (/^gemini-.*-flash/i.test(publicId)) {
    return fallbackModels.find((model) => /^gemini-.*-flash/i.test(model.id));
  }
  if (/^gemini-.*-pro/i.test(publicId)) {
    return fallbackModels.find((model) => /^gemini-.*-pro/i.test(model.id));
  }
  if (publicId.startsWith("claude-opus")) {
    return fallbackModels.find((model) => model.id.startsWith("claude-opus"));
  }
  if (publicId.startsWith("claude-")) {
    return (
      fallbackModels.find((model) => model.id.startsWith("claude-sonnet")) ??
      fallbackModels.find((model) => model.id.startsWith("claude-"))
    );
  }
  if (publicId.startsWith("gpt-oss")) {
    return fallbackModels.find((model) => model.id.startsWith("gpt-oss"));
  }
  if (publicId.startsWith("gemini-")) {
    return fallbackModels.find((model) => model.id.startsWith("gemini-"));
  }
  return undefined;
}

function publicModelName(group: RuntimeGroup): string {
  const family = group.displayNames.map((name) => displayFamily(name)).find(Boolean);
  if (family) {
    return `${titleCase(family)} (Antigravity)`;
  }
  return `${humanizePublicId(group.publicId)} (Antigravity)`;
}

function titleCase(value: string): string {
  return value.replace(/\b([a-z])/g, (char) => char.toUpperCase());
}

export function humanizePublicId(id: string): string {
  const tokens = id.split("-");
  const words: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (!token) continue;
    const next = tokens[i + 1];
    if (token === "gpt" && next === "oss") {
      words.push("GPT-OSS");
      i++;
      continue;
    }
    if (/^\d+$/.test(token) && next && /^\d+$/.test(next)) {
      words.push(`${token}.${next}`);
      i++;
      continue;
    }
    if (/^\d/.test(token)) {
      words.push(token.toUpperCase());
      continue;
    }
    words.push(token.charAt(0).toUpperCase() + token.slice(1));
  }
  return words.join(" ");
}

function parseGeminiVersion(id: string): number {
  const match = id.match(/^gemini-(\d+)(?:\.(\d+))?/i);
  if (!match) return 0;
  return Number(match[1]) * 1000 + Number(match[2] || 0);
}

function comparePublicModels(a: ProviderModelConfig, b: ProviderModelConfig): number {
  const rankA = modelRank(a.id);
  const rankB = modelRank(b.id);
  if (rankA[0] !== rankB[0]) return rankA[0] - rankB[0];
  if (rankA[1] !== rankB[1]) return rankA[1] - rankB[1];
  return a.id.localeCompare(b.id);
}

function modelRank(id: string): [number, number] {
  const version = parseGeminiVersion(id);
  if (/^gemini-.*flash/i.test(id) && !/pro/i.test(id)) return [0, -version];
  if (id.startsWith("claude-opus")) return [1, 0];
  if (id.startsWith("claude-sonnet")) return [2, 0];
  if (id.startsWith("claude-")) return [3, 0];
  if (/^gemini-.*pro/i.test(id)) return [4, -version];
  if (id.startsWith("gemini-")) return [5, -version];
  if (id.startsWith("gpt-oss")) return [6, 0];
  return [7, 0];
}
