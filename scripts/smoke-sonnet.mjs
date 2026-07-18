import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const auth = JSON.parse(readFileSync("/Users/rahularya/.pi/agent/auth.json", "utf8"));
const creds = auth.antigravity;
const mod = await import(
  pathToFileURL("/Users/rahularya/Projects/tools/pi-antigravity/src/oauth.ts").href
);
const models = await import(
  pathToFileURL("/Users/rahularya/Projects/tools/pi-antigravity/src/models.ts").href
);

const refreshed = await mod.refreshAntigravityToken({
  refresh: creds.refresh,
  access: creds.access,
  expires: creds.expires,
  projectId: creds.projectId,
  email: creds.email,
});

const runtimeModel = models.getAntigravityRequestModelId("claude-sonnet-4-6", "off");
console.log("runtimeModel=", runtimeModel);

const body = {
  project: refreshed.projectId || creds.projectId || mod.DEFAULT_PROJECT_ID,
  model: runtimeModel,
  request: {
    contents: [{ role: "user", parts: [{ text: "Reply with exactly one word: pong" }] }],
    generationConfig: { maxOutputTokens: 256 },
  },
  requestType: "agent",
  userAgent: "antigravity",
  requestId: mod.nowRequestId(),
};

const endpoint = mod.endpointCandidates()[0];
const res = await fetch(`${endpoint}/v1internal:streamGenerateContent?alt=sse`, {
  method: "POST",
  headers: {
    ...mod.antigravityHeaders(refreshed.access),
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
