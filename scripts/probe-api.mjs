import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const auth = JSON.parse(readFileSync(`${homedir()}/.pi/agent/auth.json`, "utf8"));
const creds = auth.antigravity;
const authMod = await import(new URL("../src/auth/oauth.ts", import.meta.url).href);
const client = await import(new URL("../src/client/client.ts", import.meta.url).href);

const refreshed = await authMod.refreshAntigravityToken({
  refresh: creds.refresh,
  access: creds.access,
  expires: creds.expires,
  projectId: creds.projectId,
  email: creds.email,
});

const token = refreshed.access;
const projectId = refreshed.projectId || creds.projectId;
const endpoint = client.endpointCandidates()[0];

function headers(extra = {}) {
  return {
    ...client.antigravityHeaders(token),
    Accept: "application/json",
    ...extra,
  };
}

async function probe(name, path, body) {
  const res = await fetch(`${endpoint}${path}`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text.slice(0, 2000) };
  }
  const out = {
    name,
    status: res.status,
    path,
    body,
    response: json,
  };
  console.log(`\n=== ${name} status=${res.status} ===`);
  console.log(JSON.stringify(json, null, 2).slice(0, 4000));
  return out;
}

const results = [];

results.push(
  await probe("loadCodeAssist", "/v1internal:loadCodeAssist", {
    metadata: {
      ideType: "ANTIGRAVITY",
      platform: "PLATFORM_UNSPECIFIED",
      pluginType: "GEMINI",
    },
  }),
);

results.push(
  await probe("fetchAvailableModels_project", "/v1internal:fetchAvailableModels", {
    project: projectId,
  }),
);

results.push(
  await probe("fetchAvailableModels_empty", "/v1internal:fetchAvailableModels", {}),
);

results.push(
  await probe("retrieveUserQuota", "/v1internal:retrieveUserQuota", {
    project: projectId,
  }),
);

results.push(
  await probe("retrieveUserQuota_empty", "/v1internal:retrieveUserQuota", {}),
);

results.push(
  await probe("retrieveUserQuotaSummary", "/v1internal:retrieveUserQuotaSummary", {
    project: projectId,
  }),
);

results.push(
  await probe("retrieveUserQuotaSummary_empty", "/v1internal:retrieveUserQuotaSummary", {}),
);

results.push(
  await probe("retrieveUserQuotaSummary_meta", "/v1internal:retrieveUserQuotaSummary", {
    metadata: {
      ideType: "ANTIGRAVITY",
      platform: "PLATFORM_UNSPECIFIED",
      pluginType: "GEMINI",
    },
  }),
);

results.push(
  await probe("onboardUser", "/v1internal:onboardUser", {
    metadata: {
      ideType: "ANTIGRAVITY",
      platform: "PLATFORM_UNSPECIFIED",
      pluginType: "GEMINI",
    },
  }),
);

// sanitize secrets before writing
const safe = results.map((r) => ({
  ...r,
  response: JSON.parse(
    JSON.stringify(r.response, (k, v) =>
      /token|auth|secret|email|credential/i.test(String(k)) ? "[redacted]" : v,
    ),
  ),
}));

writeFileSync(
  fileURLToPath(new URL("./probe-results.json", import.meta.url)),
  JSON.stringify({ projectId, endpoint, results: safe }, null, 2),
);
console.log("\nWrote probe-results.json");
