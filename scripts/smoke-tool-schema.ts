import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import type { Tool } from "@earendil-works/pi-ai";
import { convertTools } from "../src/stream.js";
import {
  antigravityHeaders,
  DEFAULT_PROJECT_ID,
  endpointCandidates,
  nowRequestId,
  refreshAntigravityToken,
} from "../src/oauth.js";
import { getAntigravityRequestModelId } from "../src/models.js";

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
        anyOf: [{ type: "string", enum: ["auto"] }, { type: "boolean", enum: [false] }],
      },
    },
    required: ["value"],
  },
} as Tool;

for (const modelId of ["claude-sonnet-4-6", "gpt-oss-120b"]) {
  const runtimeModel = getAntigravityRequestModelId(modelId, "high");
  const tools = convertTools([schemaProbeTool], true);
  const response = await fetch(`${endpointCandidates()[0]}/v1internal:streamGenerateContent?alt=sse`, {
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
  });

  if (!response.ok) {
    const detail = (await response.text()).replace(/ya29\.[A-Za-z0-9._~+/-]+=*/g, "[redacted]");
    throw new Error(`${modelId} rejected the tool schema (${response.status}): ${detail.slice(0, 500)}`);
  }
  console.log(`${modelId}: tool schema accepted (${response.status})`);
}
