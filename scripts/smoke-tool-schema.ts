import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import type { Tool } from "@earendil-works/pi-ai";
import { convertTools } from "../src/stream/index.js";
import { refreshAntigravityToken } from "../src/auth/index.js";
import { antigravityHeaders, DEFAULT_PROJECT_ID, endpointCandidates } from "../src/client/index.js";
import { nowRequestId } from "../src/utils/index.js";
import { getAntigravityRequestModelId } from "../src/models/index.js";

type StoredCredentials = {
  refresh: string;
  access: string;
  expires: number;
  projectId?: string;
  email?: string;
};

const authPath = `${homedir()}/.pi/agent/auth.json`;
let auth: { antigravity?: StoredCredentials };
try {
  auth = JSON.parse(await readFile(authPath, "utf8")) as { antigravity?: StoredCredentials };
} catch (error) {
  const detail = error instanceof Error ? error.message : String(error);
  throw new Error(`Could not load Antigravity credentials from ${authPath}: ${detail}`);
}
if (!auth.antigravity) throw new Error("No Antigravity credentials. Run /login antigravity first.");

const refreshed = await refreshAntigravityToken(auth.antigravity);
const projectId = refreshed.projectId || auth.antigravity.projectId || DEFAULT_PROJECT_ID;
const schemaProbeTool = {
  name: "schema_probe",
  description: "Probe JSON Schema support.",
  parameters: {
    type: "object",
    properties: {
      value: {
        anyOf: [
          { type: "string", enum: ["auto"] },
          { type: "boolean", enum: [false] },
        ],
      },
    },
    required: ["value"],
  },
} as Tool;

const modelCases = [
  { label: "Gemini 3.6 Flash (Low)", modelId: "gemini-3.6-flash", effort: "low" },
  { label: "Gemini 3.6 Flash (Medium)", modelId: "gemini-3.6-flash", effort: "medium" },
  { label: "Gemini 3.6 Flash (High)", modelId: "gemini-3.6-flash", effort: "high" },
  { label: "Gemini 3.5 Flash (Low)", modelId: "gemini-3.5-flash", effort: "minimal" },
  { label: "Gemini 3.5 Flash (Medium)", modelId: "gemini-3.5-flash", effort: "low" },
  { label: "Gemini 3.5 Flash (High)", modelId: "gemini-3.5-flash", effort: "high" },
  { label: "Gemini 3.1 Pro (Low)", modelId: "gemini-3.1-pro", effort: "low" },
  // High routes to gemini-pro-agent (gemini-3.1-pro-high currently 400s on streamGenerateContent).
  { label: "Gemini 3.1 Pro (High)", modelId: "gemini-3.1-pro", effort: "high" },
  { label: "Claude Sonnet 4.6 (Thinking)", modelId: "claude-sonnet-4-6", effort: "high" },
  { label: "Claude Opus 4.6 (Thinking)", modelId: "claude-opus-4-6", effort: "high" },
  { label: "GPT-OSS 120B (Medium)", modelId: "gpt-oss-120b", effort: "high" },
] as const;

for (const { label, modelId, effort } of modelCases) {
  const runtimeModel = getAntigravityRequestModelId(modelId, effort);
  const isCustomBackend = modelId.startsWith("claude-") || modelId.startsWith("gpt-oss-");
  const tools = convertTools([schemaProbeTool], isCustomBackend);
  const response = await fetch(
    `${endpointCandidates()[0]}/v1internal:streamGenerateContent?alt=sse`,
    {
      method: "POST",
      headers: {
        ...antigravityHeaders(refreshed.access),
        ...(modelId.startsWith("claude-")
          ? { "anthropic-beta": "interleaved-thinking-2025-05-14" }
          : {}),
      },
      body: JSON.stringify({
        project: projectId,
        model: runtimeModel,
        request: {
          contents: [{ role: "user", parts: [{ text: "Call schema_probe with value false." }] }],
          tools,
          ...(modelId.startsWith("claude-")
            ? { toolConfig: { functionCallingConfig: { mode: "AUTO" } } }
            : {}),
          generationConfig: { maxOutputTokens: 128 },
        },
        requestType: "agent",
        userAgent: "antigravity",
        requestId: nowRequestId(),
      }),
    },
  );

  if (!response.ok) {
    const detail = (await response.text()).replace(/ya29\.[A-Za-z0-9._~+/-]+=*/g, "[redacted]");
    throw new Error(
      `${label} rejected the tool schema (${response.status}): ${detail.slice(0, 500)}`,
    );
  }
  console.log(`${label}: ${runtimeModel} accepted the tool schema (${response.status})`);
}
