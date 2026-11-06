import type { Server } from "node:http";
import type {
  OAuthCredentials,
  SimpleStreamOptions,
  TextContent,
  ThinkingContent,
  ToolCall,
} from "@earendil-works/pi-ai";
import type { GeminiRole, GeminiToolCallingMode, ThinkingEffort, ToolChoice } from "./enums.js";

// OAuth & Auth Types
export type AntigravityOAuthCredentials = OAuthCredentials & {
  projectId?: string;
  email?: string;
};

export type AntigravityApiKey = {
  token: string;
  projectId: string;
};

export type DynamicModelInfo = {
  id: string;
  experiments?: string[];
  apiProvider?: string;
  modelProvider?: string;
  model?: string;
};

export type CallbackServer = {
  server: Server;
  waitForCode: () => Promise<{ code: string; state: string }>;
  cleanup: () => void;
};

// Model Types
export type AntigravityRouting = {
  off?: string;
  routing?: Partial<Record<ThinkingEffort, string>>;
  defaultRequestId?: string;
};

// Stream & API Types
export const ANTIGRAVITY_API = "antigravity-api" as const;
export type AntigravityApi = typeof ANTIGRAVITY_API;

export type AntigravityStreamOptions = Omit<SimpleStreamOptions, "toolChoice"> & {
  toolChoice?: ToolChoice;
};

export type GeminiTextPart = { text: string; thoughtSignature?: string };
export type GeminiInlineDataPart = { inlineData: { mimeType: string; data: string } };
export type GeminiThoughtPart = {
  thought: true;
  text: string;
  thoughtSignature?: string;
};
export type GeminiFunctionCallPart = {
  functionCall: {
    name: string;
    args: Record<string, unknown>;
    id?: string;
  };
  thoughtSignature?: string;
};
export type GeminiFunctionResponsePart = {
  functionResponse: {
    name: string;
    response: { error: string } | { output: string };
    id?: string;
  };
};
export type GeminiPart =
  | GeminiTextPart
  | GeminiInlineDataPart
  | GeminiThoughtPart
  | GeminiFunctionCallPart
  | GeminiFunctionResponsePart;

export type GeminiContent = {
  role: GeminiRole;
  parts: GeminiPart[];
};

export type GeminiFunctionDeclaration = {
  name: string;
  description: string;
  parameters?: unknown;
  parametersJsonSchema?: unknown;
};

export type GeminiToolConfig = {
  functionCallingConfig: {
    mode: GeminiToolCallingMode;
  };
};

export type ThinkingWire = {
  includeThoughts: boolean;
  thinkingBudget: number;
};

export type GeminiGenerationConfig = {
  temperature?: number;
  maxOutputTokens?: number;
  thinkingConfig?: ThinkingWire;
};

export type GeminiRequestBody = {
  contents: GeminiContent[];
  systemInstruction: {
    role: "user";
    parts: GeminiTextPart[];
  };
  generationConfig?: GeminiGenerationConfig;
  tools?: { functionDeclarations: GeminiFunctionDeclaration[] }[];
  toolConfig?: GeminiToolConfig;
  sessionId?: string;
  labels?: Record<string, string>;
};

export type AntigravityGenerateRequest = {
  project: string;
  model: string;
  request: GeminiRequestBody;
  requestType: "agent";
  userAgent: "antigravity";
  requestId: string;
};

export type StreamPart = {
  text?: string;
  thought?: boolean;
  thoughtSignature?: string;
  functionCall?: {
    id?: string;
    name?: string;
    args?: Record<string, unknown>;
  };
};

export type StreamUsageMetadata = {
  promptTokenCount?: number;
  cachedContentTokenCount?: number;
  candidatesTokenCount?: number;
  thoughtsTokenCount?: number;
  totalTokenCount?: number;
};

export type StreamCandidate = {
  content?: { parts?: StreamPart[] };
  finishReason?: string;
};

export type StreamResponseData = {
  candidates?: StreamCandidate[];
  usageMetadata?: StreamUsageMetadata;
  modelVersion?: string;
  responseId?: string;
};

export type StreamChunk = StreamResponseData & {
  error?: { message?: string; code?: number };
  response?: StreamResponseData;
};

export type LooseImageBlock = {
  type: "image";
  data?: string;
  mimeType?: string;
  mediaType?: string;
  source?: { data?: string; mediaType?: string };
};

export type ContentBlock = TextContent | ThinkingContent | ToolCall | LooseImageBlock;

export type ActiveTextBlock = TextContent;
export type ActiveThinkingBlock = ThinkingContent;
export type ActiveBlock = ActiveTextBlock | ActiveThinkingBlock;

// Usage & Quota Types
export type QuotaBucket = {
  bucketId: string;
  displayName: string;
  window?: string;
  resetTime?: string;
  description?: string;
  remainingFraction: number;
};

export type QuotaGroup = {
  displayName: string;
  description?: string;
  buckets: QuotaBucket[];
};

export type ModelQuotaRow = {
  modelId: string;
  displayName?: string;
  remainingFraction?: number;
  resetTime?: string;
  modelProvider?: string;
  supportsThinking?: boolean;
  supportsImages?: boolean;
  recommended?: boolean;
};

export type TierInfo = {
  id?: string;
  name?: string;
  description?: string;
};

export type AccountUsage = {
  projectId: string;
  endpoint: string;
  email?: string;
  productTier?: TierInfo;
  paidTier?: TierInfo;
  planLabel?: string;
  groups: QuotaGroup[];
  groupDescription?: string;
  /** Set when the (subscription-gated) quota-summary RPC was unavailable, e.g. free-tier SUBSCRIPTION_REQUIRED. */
  quotaSummaryError?: string;
  models: ModelQuotaRow[];
  defaultAgentModelId?: string;
  agentModelSorts?: unknown;
  fetchedAt: number;
};

export type ApiErrorBody = {
  error?: { message?: string };
  raw?: string;
};

export type QuotaBucketRaw = {
  bucketId?: unknown;
  displayName?: unknown;
  window?: unknown;
  resetTime?: unknown;
  description?: unknown;
  remainingFraction?: unknown;
};

export type QuotaGroupRaw = {
  displayName?: unknown;
  description?: unknown;
  buckets?: QuotaBucketRaw[];
};

export type QuotaSummaryRaw = {
  description?: unknown;
  groups?: QuotaGroupRaw[];
};

export type ModelInfoRaw = {
  maxTokens?: unknown;
  maxOutputTokens?: unknown;
  isInternal?: unknown;
  displayName?: unknown;
  label?: unknown;
  modelName?: unknown;
  model?: unknown;
  modelProvider?: unknown;
  apiProvider?: unknown;
  supportsThinking?: unknown;
  supportsImages?: unknown;
  recommended?: unknown;
  quotaInfo?: {
    remainingFraction?: unknown;
    resetTime?: unknown;
  };
};

export type AgentModelSortGroup = {
  modelIds?: unknown;
};

export type AgentModelSort = {
  displayName?: unknown;
  groups?: AgentModelSortGroup[];
};

export type AvailableModelsRaw = {
  models?: Record<string, ModelInfoRaw>;
  defaultAgentModelId?: unknown;
  defaultAgentModel?: unknown;
  agentModelSorts?: AgentModelSort[];
};

export type TierRaw = {
  id?: unknown;
  name?: unknown;
  description?: unknown;
};

export type LoadCodeAssistRaw = {
  currentTier?: TierRaw;
  paidTier?: TierRaw;
};
