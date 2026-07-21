import { readFileSync } from "node:fs";
import { homedir } from "node:os";

const auth = JSON.parse(readFileSync(`${homedir()}/.pi/agent/auth.json`, "utf8"));
const creds = auth.antigravity;
const authMod = await import(new URL("../src/auth/oauth.ts", import.meta.url).href);
const client = await import(new URL("../src/client/client.ts", import.meta.url).href);
const utils = await import(new URL("../src/utils/util.ts", import.meta.url).href);
const models = await import(new URL("../src/models/models.ts", import.meta.url).href);

const refreshed = await authMod.refreshAntigravityToken({
  refresh: creds.refresh,
  access: creds.access,
  expires: creds.expires,
  projectId: creds.projectId,
  email: creds.email,
});

const runtimeModel = models.getAntigravityRequestModelId("claude-sonnet-4-6", "off");
console.log("runtimeModel=", runtimeModel);

const body = {
  project: refreshed.projectId || creds.projectId || client.DEFAULT_PROJECT_ID,
  model: runtimeModel,
  request: {
    contents: [{ role: "user", parts: [{ text: "Reply with exactly one word: pong" }] }],
    generationConfig: { maxOutputTokens: 256 },
  },
  requestType: "agent",
  userAgent: "antigravity",
  requestId: utils.nowRequestId(),
};

const endpoint = client.endpointCandidates()[0];
const res = await fetch(`${endpoint}/v1internal:streamGenerateContent?alt=sse`, {
  method: "POST",
  headers: {
    ...client.antigravityHeaders(refreshed.access),
    "anthropic-beta": "interleaved-thinking-2025-05-14",
  },
  body: JSON.stringify(body),
});
console.log("status=", res.status, "endpoint=", endpoint);
const text = await res.text();
if (!res.ok) {
  console.log(text.slice(0, 800));
  process.exit(1);
}
const parts = [];
for (const line of text.split("\n")) {
  if (!line.startsWith("data:")) continue;
  const json = line.slice(5).trim();
  if (!json || json === "[DONE]") continue;
  try {
    const chunk = JSON.parse(json);
    for (const p of chunk.response?.candidates?.[0]?.content?.parts || []) {
      if (p.text) parts.push(p.text);
    }
  } catch {}
}
const joined = parts.join("");
console.log("joined=", JSON.stringify(joined));
console.log("ok=", /pong/i.test(joined) || joined.length > 0);
process.exit(/pong/i.test(joined) || joined.length > 0 ? 0 : 2);
