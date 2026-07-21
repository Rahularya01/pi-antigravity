import { readFileSync } from "node:fs";
import { homedir } from "node:os";

const auth = JSON.parse(readFileSync(`${homedir()}/.pi/agent/auth.json`, "utf8"));
const creds = auth.antigravity;
if (!creds?.refresh) {
  console.error("No antigravity credentials in auth.json");
  process.exit(1);
}

const authMod = await import(new URL("../src/auth/oauth.ts", import.meta.url).href);
const client = await import(new URL("../src/client/client.ts", import.meta.url).href);
const utils = await import(new URL("../src/utils/util.ts", import.meta.url).href);
const models = await import(new URL("../src/models/models.ts", import.meta.url).href);

console.log("email=", creds.email || "none");
console.log("projectId(auth)=", creds.projectId || "none");

const refreshed = await authMod.refreshAntigravityToken({
  refresh: creds.refresh,
  access: creds.access,
  expires: creds.expires,
  projectId: creds.projectId,
  email: creds.email,
});
console.log("refresh=ok");
console.log("projectId(refreshed)=", refreshed.projectId || "none");

const runtimeModel = models.getAntigravityRequestModelId("gemini-3.5-flash", "off");
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
  headers: client.antigravityHeaders(refreshed.access),
  body: JSON.stringify(body),
});
console.log("endpoint=", endpoint, "status=", res.status);
const text = await res.text();
if (!res.ok) {
  console.log("error=", text.slice(0, 600));
  process.exit(1);
}

const texts = [];
for (const line of text.split("\n")) {
  if (!line.startsWith("data:")) continue;
  const json = line.slice(5).trim();
  if (!json || json === "[DONE]") continue;
  try {
    const chunk = JSON.parse(json);
    const parts = chunk.response?.candidates?.[0]?.content?.parts || [];
    for (const p of parts) {
      if (p.text) texts.push({ thought: !!p.thought, text: p.text });
    }
  } catch {
    // ignore partial
  }
}

const joined = texts.map((t) => t.text).join("");
console.log("parts=", JSON.stringify(texts, null, 2));
console.log("joined=", joined);
console.log("contains_pong=", /pong/i.test(joined));
process.exit(/pong/i.test(joined) || texts.length > 0 ? 0 : 2);
