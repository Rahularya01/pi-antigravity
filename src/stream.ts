import {
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
import { getAntigravityRequestModelId, PROVIDER_ID } from "./models.js";
import {
  AntigravityRequestType,
  AntigravityUserAgent,
  GeminiRole,
  GeminiToolCallingMode,
  StopReason,
  ToolChoice,
} from "./enums.js";
import type {
  AntigravityStreamOptions,
  GeminiPart,
  GeminiContent,
  GeminiFunctionResponsePart,
  GeminiFunctionDeclaration,
  GeminiGenerationConfig,
  GeminiRequestBody,
  AntigravityGenerateRequest,
  StreamChunk,
  ContentBlock,
  ActiveBlock,
  GeminiTextPart,
  GeminiInlineDataPart,
} from "./types.js";
import {
  antigravityEnv,
  antigravityHeaders,
  DEFAULT_PROJECT_ID,
  endpointCandidates,
  fetchAvailableRuntimeModel,
  jsonOrTextError,
  lastAvailableModels,
  lastEndpoint,
  lastMatchedModelDebug,
  loadCodeAssist,
  nowRequestId,
  parseApiKey,
  safeError,
  sanitizeText,
  setLastEndpoint,
  setLastError,
  setLastProjectId,
  setLastResolvedRuntimeModel,
  setLastStatus,
  redactSecrets,
} from "./oauth.js";

export const ANTIGRAVITY_API = "antigravity-api" as const;

const ANTIGRAVITY_SYSTEM_INSTRUCTION =
  "You are Antigravity, a powerful agentic AI coding assistant designed by Google DeepMind. " +
  "You are pair programming with a user to solve coding tasks. Be concise, practical, and tool-aware.";

const ANTIGRAVITY_NO_PREAMBLE_INSTRUCTION =
  'CRITICAL: NEVER output rule checks, formatting guidelines, constraint checklists (e.g. "No emdashes"), or your thinking/personality preambles in the final response. Output only the final response.';

let toolCallCounter = 0;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasFunctionResponse(part: GeminiPart): part is GeminiFunctionResponsePart {
  return "functionResponse" in part;
}

function sanitizeToolCallId(id: string, fallbackName?: string): string {
  const cleaned = id.replace(/[^a-zA-Z0-9_-]/g, "_");
  const capped = cleaned.slice(0, 64);
  return capped || `${fallbackName || "tool"}_${Date.now()}_${++toolCallCounter}`;
}

function toolCallIdNeeded(modelId: string, runtimeModel: string): boolean {
  return (
    modelId.startsWith("claude-") ||
    modelId.startsWith("gpt-oss-") ||
    runtimeModel.startsWith("claude-") ||
    runtimeModel.startsWith("gpt-oss-")
  );
}

function asTextParts(content: unknown): Array<GeminiTextPart | GeminiInlineDataPart> {
  if (typeof content === "string") return [{ text: sanitizeText(content) }];
  if (!Array.isArray(content)) return [];
  return content.flatMap((item): Array<GeminiTextPart | GeminiInlineDataPart> => {
    if (!isRecord(item)) return [];
    const block = item as ContentBlock;
    if (block.type === "text") return [{ text: sanitizeText(block.text) }];
    if (block.type === "image") {
      const data = block.data || block.source?.data;
      const mimeType = block.mimeType || block.mediaType || block.source?.mediaType || "image/png";
      return data ? [{ inlineData: { mimeType, data } }] : [];
    }
    return [];
  });
}

function convertMessages(
  model: Model<Api>,
  context: Context,
  runtimeModel: string,
): GeminiContent[] {
  const contents: GeminiContent[] = [];
  for (const msg of context.messages) {
    if (msg.role === "user") {
      const parts = asTextParts(msg.content);
      if (parts.length) contents.push({ role: GeminiRole.User, parts });
    } else if (msg.role === "assistant") {
      const parts: GeminiPart[] = [];
      for (const block of msg.content) {
        if (block.type === "text" && String(block.text || "").trim()) {
          parts.push({ text: sanitizeText(block.text) });
        } else if (block.type === "thinking" && String(block.thinking || "").trim()) {
          if (msg.provider === PROVIDER_ID && msg.model === model.id) {
            parts.push({
              thought: true,
              text: sanitizeText(block.thinking),
              ...(block.thinkingSignature ? { thoughtSignature: block.thinkingSignature } : {}),
            });
          } else {
            parts.push({ text: sanitizeText(block.thinking) });
          }
        } else if (block.type === "toolCall") {
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
      if (parts.length) contents.push({ role: GeminiRole.Model, parts });
    } else if (msg.role === "toolResult") {
      const text = msg.content
        .filter((c): c is TextContent => c.type === "text")
        .map((c) => sanitizeText(c.text))
        .join("\n");
      const responseText = text || (msg.isError ? "Tool failed" : "");
      const part: GeminiFunctionResponsePart = {
        functionResponse: {
          name: msg.toolName,
          response: msg.isError ? { error: responseText } : { output: responseText },
          ...(toolCallIdNeeded(model.id, runtimeModel)
            ? { id: sanitizeToolCallId(msg.toolCallId || "", msg.toolName) }
            : {}),
        },
      };
      const last = contents[contents.length - 1];
      if (last?.role === GeminiRole.User && last.parts.some(hasFunctionResponse)) {
        last.parts.push(part);
      } else {
        contents.push({ role: GeminiRole.User, parts: [part] });
      }
    }
  }
  return contents;
}

function stripMetaSchema(schema: unknown): unknown {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return schema;
  const omit = new Set([
    "$schema",
    "$id",
    "$anchor",
    "$dynamicAnchor",
    "$vocabulary",
    "$comment",
    "$defs",
    "definitions",
  ]);
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (!omit.has(key)) out[key] = stripMetaSchema(value);
  }
  return out;
}

/**
 * Keywords that Cloud Code Assist's protobuf `Schema` rejects with
 * `Unknown name "..."` when tools are sent via the Claude/GPT custom-tool bridge
 * (`parameters` field). Keep this list aggressive: Pi still validates tool args
 * after the model calls them, so a slightly looser declaration is preferable to
 * a hard 400 on every Claude/GPT request.
 */
const CUSTOM_TOOL_SCHEMA_OMIT = new Set([
  // JSON Schema composition / meta not in protobuf Schema
  "anyOf",
  "oneOf",
  "allOf",
  "not",
  "if",
  "then",
  "else",
  "$schema",
  "$id",
  "$anchor",
  "$dynamicAnchor",
  "$vocabulary",
  "$comment",
  "$defs",
  "$ref",
  "$dynamicRef",
  "definitions",
  // Object keywords not present on protobuf Schema
  "patternProperties",
  "additionalProperties",
  "unevaluatedProperties",
  "propertyNames",
  "dependentSchemas",
  "dependentRequired",
  // Array keywords not present / unstable
  "prefixItems",
  "unevaluatedItems",
  "contains",
  "minContains",
  "maxContains",
  "uniqueItems",
  // Misc JSON Schema extensions that commonly appear in Pi tool defs
  "const",
  "default",
  "examples",
  "example",
  "title",
  "readOnly",
  "writeOnly",
  "deprecated",
  "contentMediaType",
  "contentEncoding",
  "contentSchema",
  // GPT-OSS Draft-2020-12 validation has rejected numeric constraints that
  // arrive through the protobuf bridge (e.g. maxLength: 60 → "'60' is not of
  // type 'integer'"). Drop them for custom backends; Pi still enforces limits.
  "maxLength",
  "minLength",
  "maxItems",
  "minItems",
  "maximum",
  "minimum",
  "exclusiveMaximum",
  "exclusiveMinimum",
  "multipleOf",
  "maxProperties",
  "minProperties",
  "pattern",
  "format",
]);

function normalizeCustomToolSchema(schema: unknown): unknown {
  if (!schema || typeof schema !== "object") return schema;
  if (Array.isArray(schema)) return schema.map(normalizeCustomToolSchema);

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (CUSTOM_TOOL_SCHEMA_OMIT.has(key) || key.startsWith("$")) continue;
    // Cloud Code Assist parses the legacy declaration through a protobuf Schema
    // (where enum is string-only) before handing it to Claude/GPT's Draft 2020-12
    // custom-tool validator. Non-string enums cannot satisfy both formats.
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
  return [
    {
      functionDeclarations: tools.map((tool) => {
        const schema = stripMetaSchema(tool.parameters);
        return {
          name: tool.name,
          description: tool.description,
          ...(useLegacyParameters
            ? { parameters: normalizeCustomToolSchema(schema) }
            : { parametersJsonSchema: schema }),
        };
      }),
    },
  ];
}

function mapToolChoiceMode(
  toolChoice: AntigravityStreamOptions["toolChoice"],
): GeminiToolCallingMode {
  if (toolChoice === ToolChoice.None) return GeminiToolCallingMode.None;
  if (toolChoice === ToolChoice.Any || toolChoice === ToolChoice.Required)
    return GeminiToolCallingMode.Any;
  return GeminiToolCallingMode.Auto;
}

function buildRequest(
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
      parts: [
        { text: ANTIGRAVITY_SYSTEM_INSTRUCTION },
        { text: `Please ignore following [ignore]${ANTIGRAVITY_SYSTEM_INSTRUCTION}[/ignore]` },
        { text: ANTIGRAVITY_NO_PREAMBLE_INSTRUCTION },
        ...(context.systemPrompt ? [{ text: sanitizeText(context.systemPrompt) }] : []),
      ],
    },
  };

  const generationConfig: GeminiGenerationConfig = {};
  if (options.temperature !== undefined) generationConfig.temperature = options.temperature;
  if (options.maxTokens !== undefined) generationConfig.maxOutputTokens = options.maxTokens;
  else generationConfig.maxOutputTokens = Math.min(8192, model.maxTokens || 8192);
  if (Object.keys(generationConfig).length) request.generationConfig = generationConfig;

  const tools = convertTools(
    context.tools,
    model.id.startsWith("claude-") || model.id.startsWith("gpt-oss-"),
  );
  if (tools) {
    request.tools = tools;
    if (model.id.startsWith("claude-")) {
      request.toolConfig = options.toolChoice
        ? {
            functionCallingConfig: {
              mode: mapToolChoiceMode(options.toolChoice),
            },
          }
        : {
            functionCallingConfig: {
              mode: GeminiToolCallingMode.Validated,
            },
          };
    } else if (options.toolChoice) {
      request.toolConfig = {
        functionCallingConfig: {
          mode: mapToolChoiceMode(options.toolChoice),
        },
      };
    }
  }

  if (options.sessionId) request.sessionId = options.sessionId;

  return {
    project: projectId,
    model: runtimeModel,
    request,
    requestType: AntigravityRequestType.Agent,
    userAgent: AntigravityUserAgent.Antigravity,
    requestId: nowRequestId(),
  };
}

function mapStopReason(reason: string | undefined): StopReason {
  if (reason === "STOP") return StopReason.Stop;
  if (reason === "MAX_TOKENS") return StopReason.Length;
  return reason ? StopReason.Error : StopReason.Stop;
}

function friendlyAntigravityError(status: number | undefined, text: string): string {
  const msg = redactSecrets(jsonOrTextError(text)).slice(0, 500);
  if (status === 400) {
    if (/API key not valid|API_KEY_INVALID/i.test(msg)) {
      return "Antigravity login expired or credentials are invalid. Next: run /login antigravity, then retry.";
    }
    if (/Invalid JSON payload|Unknown name/i.test(msg)) {
      return "Antigravity request format was rejected by the backend. Next: switch to a simpler model or retry after updating the extension.";
    }
    if (/Request contains an invalid argument/i.test(msg)) {
      return "Antigravity rejected this request. Next: retry once; if it keeps failing, switch models or re-login.";
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
      return "This model is not available right now. Next: switch to gemini-3.5-flash, gemini-3.1-pro, or another working model.";
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

function applyUsageCost(output: AssistantMessage): void {
  const m = String(output.model || "").toLowerCase();
  const inCost = m.includes("pro") ? 1.25 : 0.075;
  const outCost = m.includes("pro") ? 5.0 : 0.3;
  const cacheCost = m.includes("pro") ? 0.31 : 0.018;
  output.usage.cost.input = (output.usage.input * inCost) / 1_000_000;
  output.usage.cost.output = (output.usage.output * outCost) / 1_000_000;
  output.usage.cost.cacheRead = (output.usage.cacheRead * cacheCost) / 1_000_000;
  output.usage.cost.cacheWrite = 0;
  output.usage.cost.total =
    output.usage.cost.input + output.usage.cost.output + output.usage.cost.cacheRead;
}

function asToolCallArguments(args: Record<string, unknown> | undefined): ToolCall["arguments"] {
  return (args ?? {}) as ToolCall["arguments"];
}

async function streamResponse(
  response: Response,
  stream: AssistantMessageEventStream,
  output: AssistantMessage,
): Promise<boolean> {
  if (!response.body) throw new Error("No response body");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
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
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
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
        output.stopReason = blocks.some((b) => b.type === "toolCall")
          ? StopReason.ToolUse
          : mapStopReason(candidate.finishReason);
      }

      if (responseData.usageMetadata) {
        const prompt = responseData.usageMetadata.promptTokenCount || 0;
        const cacheRead = responseData.usageMetadata.cachedContentTokenCount || 0;
        output.usage.input = prompt - cacheRead;
        output.usage.output =
          (responseData.usageMetadata.candidatesTokenCount || 0) +
          (responseData.usageMetadata.thoughtsTokenCount || 0);
        output.usage.cacheRead = cacheRead;
        output.usage.totalTokens = responseData.usageMetadata.totalTokenCount || 0;
        applyUsageCost(output);
      }
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

  void (async () => {
    const output = createOutput(model);
    try {
      const creds = parseApiKey(opts.apiKey);
      const warmedProject = await loadCodeAssist(creds.token);
      const projectId =
        antigravityEnv("PROJECT_ID")?.trim() ||
        warmedProject ||
        creds.projectId ||
        DEFAULT_PROJECT_ID;
      setLastProjectId(projectId);

      const effort = opts.reasoning ?? "off";
      const baseRuntimeModel =
        antigravityEnv("RUNTIME_MODEL")?.trim() || getAntigravityRequestModelId(model.id, effort);

      await fetchAvailableRuntimeModel(creds.token, projectId, baseRuntimeModel);
      const runtimeModel = baseRuntimeModel;
      setLastResolvedRuntimeModel(runtimeModel);

      const body = JSON.stringify(buildRequest(model, context, projectId, opts, runtimeModel));

      const isClaudeReasoning = model.id.startsWith("claude-") && model.reasoning;
      const requestHeaders: Record<string, string> = {
        ...antigravityHeaders(creds.token),
        ...(isClaudeReasoning ? { "anthropic-beta": "interleaved-thinking-2025-05-14" } : {}),
      };

      let response: Response | undefined;
      let lastText = "";
      let received = false;

      for (let emptyAttempt = 0; emptyAttempt <= 2; emptyAttempt++) {
        if (opts.signal?.aborted) throw new Error("Request was aborted");
        if (emptyAttempt > 0) {
          const delay = 500 * 2 ** (emptyAttempt - 1);
          await new Promise((res) => setTimeout(res, delay));
        }

        for (const endpoint of endpointCandidates()) {
          setLastEndpoint(endpoint);
          response = await fetch(`${endpoint}/v1internal:streamGenerateContent?alt=sse`, {
            method: "POST",
            headers: requestHeaders,
            body,
            signal: opts.signal,
          });
          setLastStatus(response.status);
          if (response.ok) break;
          lastText = await response.text();
          if (response.status === 429 && /Individual quota reached/i.test(lastText)) break;
          if (![403, 404, 429, 500, 502, 503, 504].includes(response.status)) break;
        }

        if (!response || !response.ok) {
          // Optional debug dump: ANTIGRAVITY_DEBUG_DUMP=1 writes last failing request body.
          if (antigravityEnv("DEBUG_DUMP") === "1") {
            try {
              const { writeFileSync } = await import("node:fs");
              let parsedBody: unknown = body;
              try {
                parsedBody = JSON.parse(body) as unknown;
              } catch {
                parsedBody = body;
              }
              writeFileSync(
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
            `Antigravity API error (${response?.status ?? "no response"}, endpoint=${lastEndpoint || "unknown"}, project=${projectId}, runtimeModel=${runtimeModel}, matched=${lastMatchedModelDebug || "none"}, available=${lastAvailableModels || "unknown"}): ${friendly}`,
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

        received = await streamResponse(response, stream, output);
        if (received) break;
      }

      if (!received) throw new Error("Antigravity API returned an empty response");
      if (output.stopReason === "error" || output.stopReason === "aborted") {
        stream.push({ type: "error", reason: output.stopReason, error: output });
      } else {
        stream.push({ type: "done", reason: output.stopReason, message: output });
      }
      stream.end();
    } catch (error) {
      output.stopReason = opts.signal?.aborted ? "aborted" : "error";
      output.errorMessage = safeError(error);
      setLastError(output.errorMessage);
      stream.push({ type: "error", reason: output.stopReason, error: output });
      stream.end();
    }
  })();

  return stream;
}
