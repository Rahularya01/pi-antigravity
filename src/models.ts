import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import type { AntigravityRouting } from "./types.js";
import { ThinkingEffort } from "./enums.js";

export const PROVIDER_ID = "antigravity";
export const PROVIDER_NAME = "Antigravity";

/** Public selectable model IDs → backend request model IDs by thinking effort. */
export const ANTIGRAVITY_ROUTING: Record<string, AntigravityRouting> = {
  "claude-opus-4-6": {
    routing: {
      minimal: "claude-opus-4-6-thinking",
      low: "claude-opus-4-6-thinking",
      medium: "claude-opus-4-6-thinking",
      high: "claude-opus-4-6-thinking",
    },
    defaultRequestId: "claude-opus-4-6-thinking",
  },
  // Live fetchAvailableModels exposes `claude-sonnet-4-6` (display: Thinking), not a separate *-thinking id.
  "claude-sonnet-4-6": {
    off: "claude-sonnet-4-6",
    routing: {
      minimal: "claude-sonnet-4-6",
      low: "claude-sonnet-4-6",
      medium: "claude-sonnet-4-6",
      high: "claude-sonnet-4-6",
      xhigh: "claude-sonnet-4-6",
    },
    defaultRequestId: "claude-sonnet-4-6",
  },
  "gemini-2.5-flash": {
    off: "MODEL_GOOGLE_GEMINI_2_5_FLASH",
    routing: {
      minimal: "MODEL_GOOGLE_GEMINI_2_5_FLASH",
      low: "MODEL_GOOGLE_GEMINI_2_5_FLASH",
      medium: "MODEL_GOOGLE_GEMINI_2_5_FLASH",
      high: "MODEL_GOOGLE_GEMINI_2_5_FLASH",
    },
    defaultRequestId: "MODEL_GOOGLE_GEMINI_2_5_FLASH",
  },
  "gemini-2.5-pro": {
    routing: {
      minimal: "gemini-2.5-pro",
      low: "gemini-2.5-pro",
      medium: "gemini-2.5-pro",
      high: "gemini-2.5-pro",
    },
    defaultRequestId: "gemini-2.5-pro",
  },
  "gemini-3-flash": {
    routing: {
      minimal: "gemini-3-flash",
      low: "gemini-3-flash",
      medium: "gemini-3-flash",
      high: "gemini-3-flash",
    },
    defaultRequestId: "gemini-3-flash",
  },
  "gemini-3.1-pro": {
    off: "gemini-3.1-pro-low",
    routing: {
      minimal: "gemini-3.1-pro-low",
      low: "gemini-3.1-pro-low",
      high: "gemini-3.1-pro-high",
    },
    defaultRequestId: "gemini-3.1-pro-low",
  },
  "gemini-3.1-flash-image": {
    off: "gemini-3.1-flash-image",
    defaultRequestId: "gemini-3.1-flash-image",
  },
  "gemini-2.5-flash-lite": {
    off: "gemini-2.5-flash-lite",
    defaultRequestId: "gemini-2.5-flash-lite",
  },
  "gemini-3.1-flash-lite": {
    off: "gemini-3.1-flash-lite",
    defaultRequestId: "gemini-3.1-flash-lite",
  },
  "gemini-3.5-flash": {
    off: "gemini-3.5-flash-extra-low",
    routing: {
      minimal: "gemini-3.5-flash-extra-low",
      low: "gemini-3.5-flash-low",
      medium: "gemini-3.5-flash-low",
      high: "gemini-3-flash-agent",
      xhigh: "gemini-3-flash-agent",
    },
    defaultRequestId: "gemini-3.5-flash-extra-low",
  },
  "gpt-oss-120b": {
    off: "gpt-oss-120b-medium",
    routing: {
      minimal: "gpt-oss-120b-medium",
      low: "gpt-oss-120b-medium",
      medium: "gpt-oss-120b-medium",
      high: "gpt-oss-120b-medium",
    },
    defaultRequestId: "gpt-oss-120b-medium",
  },
  tab_flash_lite_preview: {
    off: "tab_flash_lite_preview",
    defaultRequestId: "tab_flash_lite_preview",
  },
  tab_jump_flash_lite_preview: {
    off: "tab_jump_flash_lite_preview",
    defaultRequestId: "tab_jump_flash_lite_preview",
  },
};

const freeCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const defaultThinkingMap = { off: null, xhigh: "HIGH" } as ProviderModelConfig["thinkingLevelMap"];

export const ANTIGRAVITY_MODELS: ProviderModelConfig[] = [
  {
    id: "claude-opus-4-6",
    name: "Claude Opus 4.6 (Antigravity)",
    reasoning: true,
    thinkingLevelMap: defaultThinkingMap,
    input: ["text", "image"],
    cost: freeCost,
    contextWindow: 250000,
    maxTokens: 64000,
  },
  {
    id: "claude-sonnet-4-6",
    name: "Claude Sonnet 4.6 (Antigravity)",
    reasoning: true,
    thinkingLevelMap: defaultThinkingMap,
    input: ["text", "image"],
    cost: freeCost,
    contextWindow: 200000,
    maxTokens: 64000,
  },
  {
    id: "gemini-2.5-flash",
    name: "Gemini 2.5 Flash (Antigravity)",
    reasoning: true,
    thinkingLevelMap: defaultThinkingMap,
    input: ["text", "image"],
    cost: freeCost,
    contextWindow: 1048576,
    maxTokens: 65535,
  },
  {
    id: "gemini-2.5-flash-lite",
    name: "Gemini 2.5 Flash Lite (Antigravity)",
    reasoning: false,
    input: ["text"],
    cost: freeCost,
    contextWindow: 1048576,
    maxTokens: 65535,
  },
  {
    id: "gemini-2.5-pro",
    name: "Gemini 2.5 Pro (Antigravity)",
    reasoning: true,
    thinkingLevelMap: defaultThinkingMap,
    input: ["text", "image"],
    cost: freeCost,
    contextWindow: 1048576,
    maxTokens: 65536,
  },
  {
    id: "gemini-3-flash",
    name: "Gemini 3 Flash (Antigravity)",
    reasoning: true,
    thinkingLevelMap: defaultThinkingMap,
    input: ["text", "image"],
    cost: freeCost,
    contextWindow: 1048576,
    maxTokens: 65536,
  },
  {
    id: "gemini-3.1-flash-image",
    name: "Gemini 3.1 Flash Image (Antigravity)",
    reasoning: false,
    input: ["text"],
    cost: freeCost,
    contextWindow: 200000,
    maxTokens: 64000,
  },
  {
    id: "gemini-3.1-flash-lite",
    name: "Gemini 3.1 Flash Lite (Antigravity)",
    reasoning: false,
    input: ["text"],
    cost: freeCost,
    contextWindow: 1048576,
    maxTokens: 65535,
  },
  {
    id: "gemini-3.1-pro",
    name: "Gemini 3.1 Pro (Antigravity)",
    reasoning: true,
    thinkingLevelMap: defaultThinkingMap,
    input: ["text", "image"],
    cost: freeCost,
    contextWindow: 1048576,
    maxTokens: 65535,
  },
  {
    id: "gemini-3.5-flash",
    name: "Gemini 3.5 Flash (Antigravity)",
    reasoning: true,
    thinkingLevelMap: defaultThinkingMap,
    input: ["text", "image"],
    cost: freeCost,
    contextWindow: 1048576,
    maxTokens: 65536,
  },
  {
    id: "gpt-oss-120b",
    name: "GPT-OSS 120B (Antigravity)",
    reasoning: true,
    thinkingLevelMap: defaultThinkingMap,
    input: ["text"],
    cost: freeCost,
    contextWindow: 131072,
    maxTokens: 32768,
  },
  {
    id: "tab_flash_lite_preview",
    name: "tab_flash_lite_preview (Antigravity)",
    reasoning: false,
    input: ["text"],
    cost: freeCost,
    contextWindow: 16384,
    maxTokens: 4096,
  },
  {
    id: "tab_jump_flash_lite_preview",
    name: "tab_jump_flash_lite_preview (Antigravity)",
    reasoning: false,
    input: ["text"],
    cost: freeCost,
    contextWindow: 16384,
    maxTokens: 4096,
  },
];

/** Resolve public model id + thinking effort to Antigravity runtime model id. */
export function getAntigravityRequestModelId(modelId: string, effort: string | undefined): string {
  const r = ANTIGRAVITY_ROUTING[modelId];
  if (!r) return modelId;

  if (effort === undefined || effort === "off") {
    return r.off ?? r.routing?.minimal ?? r.routing?.low ?? r.defaultRequestId ?? modelId;
  }

  const effortKey = effort as ThinkingEffort;
  if (effortKey === ThinkingEffort.Xhigh) {
    return (
      r.routing?.xhigh ??
      r.routing?.high ??
      r.routing?.low ??
      r.routing?.minimal ??
      r.off ??
      r.defaultRequestId ??
      modelId
    );
  }

  return (
    r.routing?.[effortKey] ??
    r.routing?.low ??
    r.routing?.minimal ??
    r.off ??
    r.defaultRequestId ??
    modelId
  );
}
