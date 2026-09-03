import {
  calculateCost,
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  type Model,
  type TextContent,
  type Tool,
  type ToolCall,
} from "@earendil-works/pi-ai";
import {
  antigravityHeaders,
  endpointCandidates,
  fetchAvailableRuntimeModel,
  formatRequestDiagnostics,
  jsonOrTextError,
  loadCodeAssist,
  parseApiKey,
  resolveProjectId,
} from "../client/client.js";
import {
  getCurrentEndpoint,
  runWithDiagnostics,
  setLastEndpoint,
  setLastError,
  setLastLatencyMs,
  setLastProjectId,
  setLastResolvedRuntimeModel,
  setLastStatus,
  setLastToolSchemaWarnings,
} from "../diagnostics/diagnostics.js";
import {
  AntigravityRequestType,
  AntigravityUserAgent,
  GeminiRole,
  GeminiToolCallingMode,
  StopReason,
  ToolChoice,
} from "../types/enums.js";
import {
  ANTIGRAVITY_ROUTING,
  getMaxOutputTokens,
  getAntigravityRequestModelId,
  getFallbackRuntimeModel,
  getThinkingConfig,
  PROVIDER_ID,
} from "../models/models.js";
import { redactSecrets, safeError } from "../utils/security.js";
import {
  ANTIGRAVITY_API,
  type ActiveBlock,
  type AntigravityGenerateRequest,
  type AntigravityStreamOptions,
  type ContentBlock,
  type GeminiContent,
  type GeminiFunctionDeclaration,
  type GeminiFunctionResponsePart,
  type GeminiGenerationConfig,
  type GeminiInlineDataPart,
  type GeminiPart,
  type GeminiRequestBody,
  type GeminiTextPart,
  type StreamChunk,
} from "../types/types.js";
import {
  antigravityEnv,
  antigravityRequestEnvelope,
  isRecord,
  sanitizeText,
} from "../utils/util.js";
import { antigravityFetch } from "../utils/http.js";

export { ANTIGRAVITY_API };

const ANTIGRAVITY_SYSTEM_INSTRUCTION =
  "You are Antigravity, a powerful agentic AI coding assistant designed by Google DeepMind. " +
  "You are pair programming with a user to solve coding tasks. Be concise, practical, and tool-aware.";

const ANTIGRAVITY_NO_PREAMBLE_INSTRUCTION =
  'CRITICAL: NEVER output rule checks, formatting guidelines, constraint checklists (e.g. "No emdashes"), or your thinking/personality preambles in the final response. Output only the final response.';

let toolCallCounter = 0;

function sanitizeToolCallId(id: string, fallbackName?: string): string {
  const cleaned = id.replace(/[^a-zA-Z0-9_-]/g, "_");
  const capped = cleaned.slice(0, 64);
  return capped || `${fallbackName || "tool"}_${++toolCallCounter}`;
}

function toolCallIdNeeded(modelId: string, runtimeModel: string): boolean {
  return (
    modelId.startsWith("claude-") ||
    modelId.startsWith("gpt-oss-") ||
    runtimeModel.startsWith("claude-") ||
    runtimeModel.startsWith("gpt-oss-")
  );
}

const base64SignaturePattern = /^[A-Za-z0-9+/]+={0,2}$/;
function isValidThoughtSignature(signature?: string): boolean {
  if (!signature || typeof signature !== "string" || signature.length === 0) return false;
  if (signature.length % 4 !== 0) return false;
  return base64SignaturePattern.test(signature);
}

function geminiRequiresThoughtSignature(runtimeModel: string): boolean {
  if (!runtimeModel.startsWith("gemini-")) return false;
  const match = runtimeModel.match(/^gemini-(\d+)/);
  if (match) {
    const major = Number.parseInt(match[1], 10);
    return major >= 3;
  }
  return true;
}

function parseImageData(raw: string, explicitMime?: string): { data: string; mimeType: string } {
  const match = raw.match(/^data:([^;]+);base64,(.+)$/s);
  if (match) {
    return {
      mimeType: explicitMime || match[1] || "image/png",
      data: match[2].trim(),
    };
  }
  return {
    mimeType: explicitMime || "image/png",
    data: raw.trim(),
  };
}

function asTextParts(content: unknown): Array<GeminiTextPart | GeminiInlineDataPart> {
  if (typeof content === "string") return [{ text: sanitizeText(content) }];
  if (!Array.isArray(content)) return [];
  return content.flatMap((item): Array<GeminiTextPart | GeminiInlineDataPart> => {
    if (!isRecord(item)) return [];
    const block = item as ContentBlock;
    if (block.type === "text") return [{ text: sanitizeText(block.text) }];
    if (block.type === "image") {
      const rawData = block.data || block.source?.data;
      if (!rawData) return [];
      const explicitMime = block.mimeType || block.mediaType || block.source?.mediaType;
      const { data, mimeType } = parseImageData(rawData, explicitMime);
      return data ? [{ inlineData: { mimeType, data } }] : [];
    }
    return [];
  });
}

function asImageParts(content: unknown): GeminiInlineDataPart[] {
  if (!Array.isArray(content)) return [];
  return content.flatMap((item): GeminiInlineDataPart[] => {
    if (!isRecord(item)) return [];
    const block = item as ContentBlock;
    if (block.type === "image") {
      const rawData = block.data || block.source?.data;
      if (!rawData) return [];
      const explicitMime = block.mimeType || block.mediaType || block.source?.mediaType;
      const { data, mimeType } = parseImageData(rawData, explicitMime);
      return data ? [{ inlineData: { mimeType, data } }] : [];
    }
    return [];
  });
}

function appendTurn(contents: GeminiContent[], role: GeminiRole, parts: GeminiPart[]): void {
  if (!parts.length) return;
  const last = contents[contents.length - 1];
  if (last && last.role === role) {
    last.parts.push(...parts);
  } else {
    contents.push({ role, parts });
  }
}

/** Exported for unit tests. */
export function convertMessages(
  model: Model<Api>,
  context: Context,
  runtimeModel: string,
): GeminiContent[] {
  const contents: GeminiContent[] = [];
  const requiresSig = geminiRequiresThoughtSignature(runtimeModel);
  const droppedToolCallIds = new Map<string, string>();
  for (const msg of context.messages) {
    if (msg.role === "user") {
      const parts = asTextParts(msg.content);
      appendTurn(contents, GeminiRole.User, parts);
    } else if (msg.role === "assistant") {
      if (msg.stopReason === "error" || msg.stopReason === "aborted") {
        continue;
      }
      const parts: GeminiPart[] = [];
      const isSameModel = msg.provider === PROVIDER_ID && msg.model === model.id;
      const toolCalls = msg.content.filter((b): b is ToolCall => b.type === "toolCall");
      const firstCallHasSig =
        toolCalls.length > 0 && isValidThoughtSignature(toolCalls[0]?.thoughtSignature);
      const allSigsValid = toolCalls.every(
        (tc) => !tc.thoughtSignature || isValidThoughtSignature(tc.thoughtSignature),
      );
      const groupIsSigned = isSameModel && firstCallHasSig && allSigsValid;

      for (const block of msg.content) {
        if (block.type === "text") {
          const textSig =
            isSameModel && isValidThoughtSignature(block.textSignature)
              ? block.textSignature
              : undefined;
          if ((!block.text || block.text.trim() === "") && !textSig) {
            continue;
          }
          parts.push({
            text: sanitizeText(block.text),
            ...(textSig ? { thoughtSignature: textSig } : {}),
          });
        } else if (block.type === "thinking" && String(block.thinking || "").trim()) {
          if (!isSameModel) continue;
          parts.push({
            thought: true,
            text: sanitizeText(block.thinking),
            ...(block.thinkingSignature ? { thoughtSignature: block.thinkingSignature } : {}),
          });
        } else if (block.type === "toolCall") {
          if (requiresSig && !groupIsSigned) {
            const rawId = block.id || "";
            const argsText = (() => {
              try {
                return JSON.stringify(block.arguments ?? {});
              } catch {
                return "{}";
              }
            })();
            if (rawId) {
              droppedToolCallIds.set(rawId, argsText);
              droppedToolCallIds.set(sanitizeToolCallId(rawId, block.name), argsText);
            } else {
              droppedToolCallIds.set(`empty:${block.name}`, argsText);
            }
          } else {
            parts.push({
              functionCall: {
                name: block.name,
                args: block.arguments ?? {},
                ...(toolCallIdNeeded(model.id, runtimeModel)
                  ? { id: sanitizeToolCallId(block.id || "", block.name) }
                  : {}),
              },
              ...(block.thoughtSignature ? { thoughtSignature: block.thoughtSignature } : {}),
            });
          }
        }
      }
      appendTurn(contents, GeminiRole.Model, parts);
    } else if (msg.role === "toolResult") {
      const text = msg.content
        .filter((c): c is TextContent => c.type === "text")
        .map((c) => sanitizeText(c.text))
        .join("\n");
      const responseText = text || (msg.isError ? "Tool failed" : "");
      const imageParts = asImageParts(msg.content);
      const rawId = msg.toolCallId || "";
      const sanitizedId = toolCallIdNeeded(model.id, runtimeModel)
        ? sanitizeToolCallId(rawId, msg.toolName)
        : rawId;
      const droppedArgs = requiresSig
        ? (droppedToolCallIds.get(rawId) ??
          droppedToolCallIds.get(sanitizedId) ??
          (rawId === "" ? droppedToolCallIds.get(`empty:${msg.toolName}`) : undefined))
        : undefined;
      if (droppedArgs !== undefined) {
        const label =
          droppedArgs === "{}" ? `\`${msg.toolName}\`` : `\`${msg.toolName}\` (${droppedArgs})`;
        appendTurn(contents, GeminiRole.User, [
          { text: sanitizeText(`[Observation from ${label}:\n${responseText}]`) },
          ...imageParts,
        ]);
      } else {
        const part: GeminiFunctionResponsePart = {
          functionResponse: {
            name: msg.toolName,
            response: msg.isError ? { error: responseText } : { output: responseText },
            ...(toolCallIdNeeded(model.id, runtimeModel)
              ? { id: sanitizeToolCallId(msg.toolCallId || "", msg.toolName) }
              : {}),
          },
        };
        appendTurn(contents, GeminiRole.User, [part, ...imageParts]);
      }
    }
  }

  // Google Antigravity / Gemini requires the first turn to be from 'user'.
  // If the conversation starts with 'model' (e.g. initial assistant greeting),
  // prepend a minimal user message to prevent backend 400 rejection.
  if (contents.length > 0 && contents[0]?.role === GeminiRole.Model) {
    contents.unshift({
      role: GeminiRole.User,
      parts: [{ text: "Hello" }],
    });
  }

  return contents;
}

type SchemaReferenceIssue = {
  path: string;
  ref: string;
  reason: string;
};

type DereferencedSchema = {
  schema: unknown;
  issues: SchemaReferenceIssue[];
};

type DereferenceState = {
  nodes: number;
};

const MAX_SCHEMA_DEREFERENCE_DEPTH = 64;
const MAX_SCHEMA_DEREFERENCE_NODES = 10_000;
const SCHEMA_MAP_KEYWORDS = new Set([
  "properties",
  "patternProperties",
  "dependentSchemas",
  "dependencies",
]);
const SCHEMA_VALUE_KEYWORDS = new Set([
  "additionalItems",
  "additionalProperties",
  "contains",
  "contentSchema",
  "else",
  "if",
  "items",
  "not",
  "propertyNames",
  "then",
  "unevaluatedItems",
  "unevaluatedProperties",
]);
const SCHEMA_ARRAY_KEYWORDS = new Set(["allOf", "anyOf", "oneOf", "prefixItems"]);

/** Resolve a local RFC 6901 JSON Pointer against the original tool schema. */
function resolveLocalJsonPointer(ref: string, rootSchema: unknown): unknown {
  if (ref === "#") return rootSchema;
  if (!ref.startsWith("#/")) return undefined;

  let current: unknown = rootSchema;
  for (const token of ref.slice(2).split("/")) {
    const key = token.replace(/~1/g, "/").replace(/~0/g, "~");
    if (Array.isArray(current)) {
      if (!/^(0|[1-9]\d*)$/.test(key)) return undefined;
      const index = Number(key);
      if (!Number.isSafeInteger(index) || index >= current.length) return undefined;
      current = current[index];
      continue;
    }
    if (!current || typeof current !== "object") return undefined;
    if (!Object.prototype.hasOwnProperty.call(current, key)) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

/** Dereference every schema in a keyword map without interpreting map keys as JSON Schema keywords. */
function dereferenceSchemaMap(
  schemaMap: unknown,
  rootSchema: unknown,
  refStack: Set<string>,
  objectStack: Set<object>,
  state: DereferenceState,
  path: string,
  depth: number,
): DereferencedSchema {
  if (!isRecord(schemaMap)) {
    return dereferenceSchema(schemaMap, rootSchema, refStack, objectStack, state, path, depth);
  }

  const out: Record<string, unknown> = {};
  const issues: SchemaReferenceIssue[] = [];
  for (const [key, value] of Object.entries(schemaMap)) {
    const result = dereferenceSchema(
      value,
      rootSchema,
      refStack,
      objectStack,
      state,
      `${path}.${key}`,
      depth,
    );
    out[key] = result.schema;
    issues.push(...result.issues);
  }
  return { schema: out, issues };
}

/**
 * Inline reachable local references while bounding expansion of untrusted MCP schemas.
 * A reported issue causes only the affected tool declaration to be omitted.
 */
function dereferenceSchema(
  schema: unknown,
  rootSchema: unknown = schema,
  refStack = new Set<string>(),
  objectStack = new Set<object>(),
  state: DereferenceState = { nodes: 0 },
  path = "$",
  depth = 0,
): DereferencedSchema {
  if (depth > MAX_SCHEMA_DEREFERENCE_DEPTH) {
    return {
      schema: {},
      issues: [
        {
          path,
          ref: "(depth limit)",
          reason: `schema expansion exceeded ${MAX_SCHEMA_DEREFERENCE_DEPTH} levels`,
        },
      ],
    };
  }
  state.nodes += 1;
  if (state.nodes > MAX_SCHEMA_DEREFERENCE_NODES) {
    return {
      schema: {},
      issues: [
        {
          path,
          ref: "(node limit)",
          reason: `schema expansion exceeded ${MAX_SCHEMA_DEREFERENCE_NODES} nodes`,
        },
      ],
    };
  }
  if (!schema || typeof schema !== "object") return { schema, issues: [] };

  if (Array.isArray(schema)) {
    const results = schema.map((item, index) =>
      dereferenceSchema(
        item,
        rootSchema,
        refStack,
        objectStack,
        state,
        `${path}[${index}]`,
        depth + 1,
      ),
    );
    return {
      schema: results.map((result) => result.schema),
      issues: results.flatMap((result) => result.issues),
    };
  }

  const s = schema as Record<string, unknown>;
  if (objectStack.has(s)) {
    return {
      schema: {},
      issues: [{ path, ref: "(object cycle)", reason: "circular schema object" }],
    };
  }

  const nextObjectStack = new Set(objectStack);
  nextObjectStack.add(s);

  if (typeof s.$ref === "string") {
    const ref = s.$ref;
    if (refStack.has(ref)) {
      return {
        schema: {},
        issues: [{ path, ref, reason: "circular local reference" }],
      };
    }

    const target = resolveLocalJsonPointer(ref, rootSchema);
    if (target === undefined) {
      return {
        schema: {},
        issues: [{ path, ref, reason: "target is not present in the root schema" }],
      };
    }

    const nextRefStack = new Set(refStack);
    nextRefStack.add(ref);
    const resolved = dereferenceSchema(
      target,
      rootSchema,
      nextRefStack,
      nextObjectStack,
      state,
      path,
      depth + 1,
    );
    const { $ref: _, ...siblings } = s;
    const siblingResult = dereferenceSchema(
      siblings,
      rootSchema,
      refStack,
      nextObjectStack,
      state,
      path,
      depth + 1,
    );

    if (isRecord(resolved.schema) && isRecord(siblingResult.schema)) {
      return {
        schema: { ...resolved.schema, ...siblingResult.schema },
        issues: [...resolved.issues, ...siblingResult.issues],
      };
    }
    return {
      schema: resolved.schema,
      issues: [...resolved.issues, ...siblingResult.issues],
    };
  }

  const out: Record<string, unknown> = {};
  const issues: SchemaReferenceIssue[] = [];
  for (const [key, value] of Object.entries(s)) {
    // Definitions are available through rootSchema while resolving $ref, but must
    // not be emitted because the Antigravity backend requires self-contained schemas.
    if (key === "$defs" || key === "definitions") continue;

    let result: DereferencedSchema | undefined;
    if (SCHEMA_MAP_KEYWORDS.has(key)) {
      result = dereferenceSchemaMap(
        value,
        rootSchema,
        refStack,
        nextObjectStack,
        state,
        `${path}.${key}`,
        depth + 1,
      );
    } else if (SCHEMA_VALUE_KEYWORDS.has(key) || SCHEMA_ARRAY_KEYWORDS.has(key)) {
      result = dereferenceSchema(
        value,
        rootSchema,
        refStack,
        nextObjectStack,
        state,
        `${path}.${key}`,
        depth + 1,
      );
    }

    if (result) {
      out[key] = result.schema;
      issues.push(...result.issues);
    } else {
      out[key] = value;
    }
  }
  return { schema: out, issues };
}

function ensureRootObjectSchema(schema: unknown): Record<string, unknown> {
  if (!isRecord(schema)) {
    return { type: "object", properties: {} };
  }
  if (!schema.type) {
    return { ...schema, type: "object", properties: schema.properties || {} };
  }
  return schema;
}

const META_SCHEMA_KEYWORDS = new Set([
  "$schema",
  "$id",
  "$anchor",
  "$dynamicAnchor",
  "$vocabulary",
  "$comment",
  "$defs",
  "definitions",
]);

/** Remove schema metadata without treating user-defined property names as keywords. */
function stripMetaSchemaMap(schemaMap: unknown): unknown {
  if (!isRecord(schemaMap)) return stripMetaSchema(schemaMap);
  return Object.fromEntries(
    Object.entries(schemaMap).map(([key, value]) => [key, stripMetaSchema(value)]),
  );
}

/** Remove metadata that Cloud Code Assist rejects from JSON Schema keyword positions. */
function stripMetaSchema(schema: unknown): unknown {
  if (!schema || typeof schema !== "object") return schema;
  if (Array.isArray(schema)) return schema.map(stripMetaSchema);

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (META_SCHEMA_KEYWORDS.has(key)) continue;
    if (SCHEMA_MAP_KEYWORDS.has(key)) {
      out[key] = stripMetaSchemaMap(value);
    } else if (SCHEMA_VALUE_KEYWORDS.has(key) || SCHEMA_ARRAY_KEYWORDS.has(key)) {
      out[key] = stripMetaSchema(value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

/**
 * Protobuf `Schema` fields accepted by Cloud Code Assist's Claude/GPT custom-tool
 * bridge (`parameters` field). Anything else — `nullable`, `anyOf`, `format`,
 * `$ref`, etc. — returns `Unknown name "..."` / Invalid JSON payload (400).
 * Allowlist rather than denylist so new JSON Schema keywords cannot 400 the request.
 * Pi still validates tool args after the model calls them.
 */
const CUSTOM_TOOL_SCHEMA_ALLOW = new Set([
  "type",
  "description",
  "properties",
  "required",
  "items",
  "enum",
]);

function normalizeCustomToolType(value: unknown): unknown {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return undefined;
  // JSON Schema union types like ["string","null"] → first non-null scalar type.
  const entries = value as unknown[];
  const scalar = entries.find(
    (entry): entry is string => typeof entry === "string" && entry !== "null",
  );
  return scalar;
}

function normalizeCustomToolSchema(schema: unknown): unknown {
  if (!schema || typeof schema !== "object") return schema;
  if (Array.isArray(schema)) return schema.map(normalizeCustomToolSchema);

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (!CUSTOM_TOOL_SCHEMA_ALLOW.has(key)) continue;
    if (key === "type") {
      const normalizedType = normalizeCustomToolType(value);
      if (normalizedType !== undefined) out.type = normalizedType;
      continue;
    }
    if (key === "properties" && value && typeof value === "object" && !Array.isArray(value)) {
      // Property names are user-defined, not Schema keywords — never allowlist-filter them.
      const props: Record<string, unknown> = {};
      for (const [propName, propSchema] of Object.entries(value as Record<string, unknown>)) {
        props[propName] = normalizeCustomToolSchema(propSchema);
      }
      out.properties = props;
      continue;
    }
    if (
      key === "enum" &&
      Array.isArray(value) &&
      !value.every((entry) => typeof entry === "string")
    ) {
      continue;
    }
    out[key] = normalizeCustomToolSchema(value);
  }
  return out;
}

/**
 * Gemini accepts JSON Schema through parametersJsonSchema. Claude and GPT-OSS
 * use Cloud Code Assist's custom-tool bridge, which requires a compatible
 * Draft 2020-12 subset in the legacy parameters field.
 */
export function convertTools(
  tools: Tool[] | undefined,
  useLegacyParameters = false,
): { functionDeclarations: GeminiFunctionDeclaration[] }[] | undefined {
  if (!tools?.length) return undefined;

  const warnings: string[] = [];
  const functionDeclarations = tools.flatMap((tool) => {
    const dereferenced = dereferenceSchema(tool.parameters);
    if (dereferenced.issues.length > 0) {
      const detail = dereferenced.issues
        .map((issue) => `${issue.path} (${issue.ref}: ${issue.reason})`)
        .join(", ");
      warnings.push(`Skipped tool '${tool.name}' due to unresolved schema reference: ${detail}`);
      return [];
    }

    const rootObject = ensureRootObjectSchema(dereferenced.schema);
    const schema = stripMetaSchema(rootObject);
    return [
      {
        name: tool.name,
        description: tool.description,
        ...(useLegacyParameters
          ? { parameters: normalizeCustomToolSchema(schema) }
          : { parametersJsonSchema: schema }),
      },
    ];
  });

  setLastToolSchemaWarnings(warnings.length ? warnings : undefined);
  if (!functionDeclarations.length) return undefined;
  return [{ functionDeclarations }];
}

function mapToolChoiceMode(
  toolChoice: AntigravityStreamOptions["toolChoice"],
): GeminiToolCallingMode {
  if (toolChoice === ToolChoice.None) return GeminiToolCallingMode.None;
  if (toolChoice === ToolChoice.Any || toolChoice === ToolChoice.Required)
    return GeminiToolCallingMode.Any;
  return GeminiToolCallingMode.Auto;
}

/** Exported for unit tests. */
export function buildRequest(
  model: Model<Api>,
  context: Context,
  projectId: string,
  options: AntigravityStreamOptions,
  runtimeModel: string,
): AntigravityGenerateRequest {
  const request: GeminiRequestBody = {
    contents: convertMessages(model, context, runtimeModel),
    systemInstruction: {
      role: GeminiRole.User,
      parts: context.systemPrompt
        ? [{ text: sanitizeText(context.systemPrompt) }]
        : [{ text: ANTIGRAVITY_SYSTEM_INSTRUCTION }, { text: ANTIGRAVITY_NO_PREAMBLE_INSTRUCTION }],
    },
  };

  const generationConfig: GeminiGenerationConfig = {};
  if (options.temperature !== undefined) generationConfig.temperature = options.temperature;
  const thinking = getThinkingConfig(model.id, options.reasoning ?? "off");
  if (thinking) generationConfig.thinkingConfig = thinking;
  const maxAllowed = getMaxOutputTokens(model.id, runtimeModel);
  if (options.maxTokens !== undefined) {
    generationConfig.maxOutputTokens = Math.min(options.maxTokens, maxAllowed);
  } else {
    generationConfig.maxOutputTokens = Math.min(maxAllowed, model.maxTokens || maxAllowed);
  }
  if (Object.keys(generationConfig).length) request.generationConfig = generationConfig;

  const isClaude = model.id.startsWith("claude-") || runtimeModel.startsWith("claude-");
  const tools = convertTools(context.tools, isClaude || model.id.startsWith("gpt-oss-"));
  if (tools) {
    request.tools = tools;
    request.toolConfig = {
      functionCallingConfig: {
        mode:
          options.toolChoice && options.toolChoice !== ToolChoice.Auto
            ? mapToolChoiceMode(options.toolChoice)
            : GeminiToolCallingMode.Validated,
      },
    };
  } else if (isClaude) {
    request.toolConfig = {
      functionCallingConfig: { mode: GeminiToolCallingMode.Validated },
    };
  }

  const envelope = antigravityRequestEnvelope(runtimeModel, isClaude);
  request.sessionId = options.sessionId || envelope.sessionId;
  request.labels = envelope.labels;

  return {
    project: projectId,
    model: runtimeModel,
    request,
    requestType: AntigravityRequestType.Agent,
    userAgent: AntigravityUserAgent.Antigravity,
    requestId: envelope.requestId,
  };
}

/** Exported for unit tests. */
export function mapStopReason(reason: string | undefined): StopReason {
  if (reason === "STOP") return StopReason.Stop;
  if (reason === "MAX_TOKENS") return StopReason.Length;
  return reason ? StopReason.Error : StopReason.Stop;
}

/** Exported for unit tests. */
export function friendlyAntigravityError(status: number | undefined, text: string): string {
  const msg = redactSecrets(jsonOrTextError(text)).slice(0, 500);
  if (status === 400) {
    if (/API key not valid|API_KEY_INVALID/i.test(msg)) {
      return "Antigravity login expired or credentials are invalid. Next: run /login antigravity, then retry.";
    }
    if (/Invalid JSON payload|Unknown name/i.test(msg)) {
      return `Antigravity request format was rejected by the backend (${msg}). Next: switch to a simpler model or retry after updating the extension.`;
    }
    if (/Request contains an invalid argument/i.test(msg)) {
      return `Antigravity rejected this request (${msg}). Next: retry once; if it keeps failing, switch models or re-login.`;
    }
    return `Bad request from Antigravity. Next: retry once, then run /login antigravity if it keeps failing. Backend said: ${msg}`;
  }
  if (status === 401) {
    return "Antigravity authentication failed. Next: run /login antigravity, then retry.";
  }
  if (status === 403) {
    if (/permission|forbidden|access/i.test(msg)) {
      return "Antigravity access was denied for this account or project. Next: try another model, re-login, or use an account with access.";
    }
    return `Antigravity denied this request. Next: re-login or try another model. Backend said: ${msg}`;
  }
  if (status === 404) {
    if (/Requested entity was not found/i.test(msg)) {
      return "This model is not available right now. Next: switch to gemini-3.8-flash, gemini-3.7-flash, gemini-3.6-flash, gemini-3.5-flash, gemini-3.1-pro, or another working model.";
    }
    return `Antigravity could not find the requested resource. Next: retry or switch models. Backend said: ${msg}`;
  }
  if (status === 408) return "Antigravity timed out. Next: retry the same request.";
  if (status === 409) {
    return "Antigravity reported a conflict for this request. Next: retry once or start a new chat session.";
  }
  if (status === 429) {
    const wait = msg.match(/Resets? in ([^.\n]+)/i)?.[1]?.trim();
    if (/Individual quota reached/i.test(msg)) {
      return `Quota reached. Please wait ${wait || "for reset"}. Next: switch models or try again after reset.`;
    }
    if (/quota/i.test(msg)) {
      return `Quota reached.${wait ? ` Please wait ${wait}.` : ""} Next: switch models or retry later.`;
    }
    return `Rate limited by Antigravity. Next: wait a bit and retry.${wait ? ` Reset: ${wait}.` : ""}`;
  }
  if (status === 500) {
    return "Antigravity had an internal server error. Next: retry in a moment or switch models.";
  }
  if (status === 502) return "Antigravity returned a bad gateway error. Next: retry in a moment.";
  if (status === 503) {
    if (/No capacity available/i.test(msg)) {
      return "This model has no capacity right now. Next: retry later or switch to another model.";
    }
    return "Antigravity is temporarily unavailable. Next: retry in a moment or switch models.";
  }
  if (status === 504) return "Antigravity timed out upstream. Next: retry in a moment.";
  return msg;
}

function createOutput(model: Model<Api>): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: ANTIGRAVITY_API,
    provider: PROVIDER_ID,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

function asToolCallArguments(args: Record<string, unknown> | undefined): ToolCall["arguments"] {
  return (args ?? {}) as ToolCall["arguments"];
}

/** Exported for unit tests. */
export async function streamResponse(
  response: Response,
  stream: AssistantMessageEventStream,
  output: AssistantMessage,
  model?: Model<Api>,
): Promise<boolean> {
  if (!response.body) throw new Error("No response body");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  // Consumed-prefix offset: the buffer is compacted once per network chunk instead of
  // re-copying the whole remainder for every SSE line.
  let scanStart = 0;
  let started = false;
  let currentBlock: ActiveBlock | null = null;
  let hasContent = false;
  const blocks = output.content;
  const blockIndex = () => blocks.length - 1;

  const ensureStarted = () => {
    if (!started) {
      stream.push({ type: "start", partial: output });
      started = true;
    }
  };

  const finishCurrent = () => {
    if (!currentBlock) return;
    if (currentBlock.type === "text") {
      stream.push({
        type: "text_end",
        contentIndex: blockIndex(),
        content: currentBlock.text,
        partial: output,
      });
    } else {
      stream.push({
        type: "thinking_end",
        contentIndex: blockIndex(),
        content: currentBlock.thinking,
        partial: output,
      });
    }
    currentBlock = null;
  };

  while (true) {
    const result = await reader.read();
    if (result.done) break;
    if (!(result.value instanceof Uint8Array)) continue;
    buffer += decoder.decode(result.value, { stream: true });

    let newlineIdx: number;
    while ((newlineIdx = buffer.indexOf("\n", scanStart)) !== -1) {
      const line = buffer.slice(scanStart, newlineIdx);
      scanStart = newlineIdx + 1;
      if (!line.startsWith("data:")) continue;
      const json = line.slice(5).trim();
      if (!json || json === "[DONE]") continue;

      let chunk: StreamChunk;
      try {
        chunk = JSON.parse(json) as StreamChunk;
      } catch {
        continue;
      }

      if (chunk.error) {
        throw new Error(chunk.error.message || JSON.stringify(chunk.error));
      }

      const responseData = chunk.response || chunk;
      const candidate = responseData.candidates?.[0];

      for (const part of candidate?.content?.parts || []) {
        if (part.text !== undefined) {
          hasContent = true;
          const isThinking = part.thought === true;
          const type = isThinking ? "thinking" : "text";
          if (!currentBlock || currentBlock.type !== type) {
            finishCurrent();
            currentBlock = isThinking
              ? { type: "thinking", thinking: "", thinkingSignature: undefined }
              : { type: "text", text: "" };
            blocks.push(currentBlock);
            ensureStarted();
            stream.push({
              type: isThinking ? "thinking_start" : "text_start",
              contentIndex: blockIndex(),
              partial: output,
            });
          }
          if (isThinking && currentBlock.type === "thinking") {
            currentBlock.thinking += part.text;
            if (part.thoughtSignature) currentBlock.thinkingSignature = part.thoughtSignature;
            stream.push({
              type: "thinking_delta",
              contentIndex: blockIndex(),
              delta: part.text,
              partial: output,
            });
          } else if (!isThinking && currentBlock.type === "text") {
            currentBlock.text += part.text;
            if (part.thoughtSignature) currentBlock.textSignature = part.thoughtSignature;
            stream.push({
              type: "text_delta",
              contentIndex: blockIndex(),
              delta: part.text,
              partial: output,
            });
          }
        }

        if (part.functionCall) {
          hasContent = true;
          finishCurrent();
          const rawId = part.functionCall.id || "";
          const toolCall: ToolCall = {
            type: "toolCall",
            id: sanitizeToolCallId(rawId, part.functionCall.name),
            name: part.functionCall.name || "",
            arguments: asToolCallArguments(part.functionCall.args),
            ...(part.thoughtSignature ? { thoughtSignature: part.thoughtSignature } : {}),
          };
          blocks.push(toolCall);
          ensureStarted();
          stream.push({ type: "toolcall_start", contentIndex: blockIndex(), partial: output });
          stream.push({
            type: "toolcall_delta",
            contentIndex: blockIndex(),
            delta: JSON.stringify(toolCall.arguments),
            partial: output,
          });
          stream.push({
            type: "toolcall_end",
            contentIndex: blockIndex(),
            toolCall,
            partial: output,
          });
        }
      }

      if (candidate?.finishReason) {
        output.rawStopReason = candidate.finishReason;
        output.stopReason = blocks.some((b) => b.type === "toolCall")
          ? StopReason.ToolUse
          : mapStopReason(candidate.finishReason);
      }

      if (responseData.usageMetadata) {
        const prompt = responseData.usageMetadata.promptTokenCount || 0;
        const cacheRead = responseData.usageMetadata.cachedContentTokenCount || 0;
        const thoughts = responseData.usageMetadata.thoughtsTokenCount || 0;
        output.usage.input = prompt - cacheRead;
        output.usage.output = (responseData.usageMetadata.candidatesTokenCount || 0) + thoughts;
        output.usage.reasoning = thoughts;
        output.usage.cacheRead = cacheRead;
        output.usage.totalTokens = responseData.usageMetadata.totalTokenCount || 0;
        if (model?.cost) {
          calculateCost(model, output.usage);
        } else {
          output.usage.cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
        }
      }
    }

    if (scanStart > 0) {
      buffer = buffer.slice(scanStart);
      scanStart = 0;
    }
  }

  finishCurrent();
  return hasContent;
}

export function streamAntigravity(
  model: Model<Api>,
  context: Context,
  options?: AntigravityStreamOptions,
): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  const opts = options ?? {};

  void runWithDiagnostics(async () => {
    const startTime = Date.now();
    const output = createOutput(model);
    try {
      const creds = parseApiKey(opts.apiKey);
      // Skip loadCodeAssist roundtrip when credentials already carry a projectId.
      const warmedProject = creds.projectId ? null : await loadCodeAssist(creds.token);
      const projectId = resolveProjectId({
        token: creds.token,
        warmedProject,
        credentialProjectId: creds.projectId,
      });
      setLastProjectId(projectId);

      const effort = opts.reasoning ?? "off";
      const isKnownModel = model.id in ANTIGRAVITY_ROUTING;
      const baseRuntimeModel =
        antigravityEnv("RUNTIME_MODEL")?.trim() || getAntigravityRequestModelId(model.id, effort);

      let initialRuntimeModel = baseRuntimeModel;
      // Skip pre-flight model discovery for known static models to optimize TTFT latency.
      // Dynamic lookup is only needed for unmapped custom models.
      if (!isKnownModel && !antigravityEnv("RUNTIME_MODEL")) {
        const dynamic = await fetchAvailableRuntimeModel(creds.token, projectId, baseRuntimeModel);
        if (dynamic?.id && /^(gemini-|claude-|gpt-oss-)/i.test(dynamic.id)) {
          initialRuntimeModel = dynamic.id;
        }
      }

      const runtimeCandidates = [initialRuntimeModel];
      const fallback = getFallbackRuntimeModel(initialRuntimeModel, effort);
      if (fallback && fallback !== initialRuntimeModel) {
        runtimeCandidates.push(fallback);
      }

      const isClaudeReasoning = model.id.startsWith("claude-") && model.reasoning;
      const requestHeaders: Record<string, string> = {
        ...antigravityHeaders(creds.token),
        ...(isClaudeReasoning ? { "anthropic-beta": "interleaved-thinking-2025-05-14" } : {}),
      };

      let response: Response | undefined;
      let lastText = "";
      let received = false;
      let runtimeModel = initialRuntimeModel;

      for (let emptyAttempt = 0; emptyAttempt <= 2; emptyAttempt++) {
        if (opts.signal?.aborted) throw new Error("Request was aborted");
        if (emptyAttempt > 0) {
          const delay = 500 * 2 ** (emptyAttempt - 1);
          await new Promise((res) => setTimeout(res, delay));
        }

        for (let candIdx = 0; candIdx < runtimeCandidates.length; candIdx++) {
          runtimeModel = runtimeCandidates[candIdx]!;
          setLastResolvedRuntimeModel(runtimeModel);
          const body = JSON.stringify(buildRequest(model, context, projectId, opts, runtimeModel));

          for (const endpoint of endpointCandidates()) {
            setLastEndpoint(endpoint);
            response = await antigravityFetch(
              `${endpoint}/v1internal:streamGenerateContent?alt=sse`,
              {
                method: "POST",
                headers: requestHeaders,
                body,
                signal: opts.signal,
              },
            );
            setLastStatus(response.status);
            if (response.ok) break;
            lastText = await response.text();
            if (response.status === 429 && /Individual quota reached/i.test(lastText)) break;
            if (![403, 404, 429, 500, 502, 503, 504].includes(response.status)) break;
          }

          if (response?.ok) break;
          if (response?.status === 404) {
            if (candIdx + 1 < runtimeCandidates.length) {
              continue;
            }
            if (isKnownModel && candIdx === runtimeCandidates.length - 1) {
              const dynamic = await fetchAvailableRuntimeModel(
                creds.token,
                projectId,
                baseRuntimeModel,
              );
              if (
                dynamic?.id &&
                !runtimeCandidates.includes(dynamic.id) &&
                /^(gemini-|claude-|gpt-oss-)/i.test(dynamic.id)
              ) {
                runtimeCandidates.push(dynamic.id);
                continue;
              }
            }
          }
          break;
        }

        if (!response || !response.ok) {
          if (antigravityEnv("DEBUG_DUMP") === "1") {
            try {
              const body = JSON.stringify(
                buildRequest(model, context, projectId, opts, runtimeModel),
              );
              let parsedBody: unknown = body;
              try {
                parsedBody = JSON.parse(body) as unknown;
              } catch {
                parsedBody = body;
              }
              await (
                await import("node:fs/promises")
              ).writeFile(
                "/tmp/antigravity-last-request.json",
                JSON.stringify(
                  {
                    status: response?.status,
                    runtimeModel,
                    lastText: lastText.slice(0, 4000),
                    body: parsedBody,
                  },
                  null,
                  2,
                ),
              );
            } catch {
              // ignore dump failures
            }
          }
          const friendly = friendlyAntigravityError(response?.status, lastText);
          if (response?.status === 429 && /Quota reached\./i.test(friendly)) {
            throw new Error(friendly);
          }
          throw new Error(
            `Antigravity API error (${response?.status ?? "no response"}, ${formatRequestDiagnostics({ projectId, runtimeModel })}): ${friendly}`,
          );
        }

        output.content = [];
        output.usage = {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        };
        output.stopReason = "stop";

        received = await streamResponse(response, stream, output, model);
        if (received) break;
      }

      if (!received) throw new Error("Antigravity API returned an empty response");
      setLastLatencyMs(Date.now() - startTime);
      if (output.stopReason === "error" || output.stopReason === "aborted") {
        const errorDetail = output.rawStopReason
          ? `Provider stopped with: ${output.rawStopReason}`
          : "An unknown error occurred";
        output.errorMessage = output.errorMessage || errorDetail;
        setLastError(output.errorMessage);
        stream.push({ type: "error", reason: output.stopReason, error: output });
      } else if (output.stopReason === "pending") {
        throw new Error("Antigravity API returned no stop reason");
      } else {
        stream.push({ type: "done", reason: output.stopReason, message: output });
      }
      stream.end();
    } catch (error) {
      setLastLatencyMs(Date.now() - startTime);
      output.stopReason = opts.signal?.aborted ? "aborted" : "error";
      output.errorMessage = safeError(error);
      setLastError(output.errorMessage);
      // Ensure endpoint is recorded even if failure happened before setLastEndpoint.
      if (!getCurrentEndpoint() && endpointCandidates()[0]) {
        setLastEndpoint(endpointCandidates()[0]);
      }
      stream.push({ type: "error", reason: output.stopReason, error: output });
      stream.end();
    }
  });

  return stream;
}
