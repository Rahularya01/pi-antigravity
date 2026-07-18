import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const auth = JSON.parse(readFileSync("/Users/rahularya/.pi/agent/auth.json", "utf8"));
const creds = auth.antigravity;
const mod = await import(
  pathToFileURL("/Users/rahularya/Projects/tools/pi-antigravity/src/oauth.ts").href
);

const refreshed = await mod.refreshAntigravityToken({
  refresh: creds.refresh,
  access: creds.access,
  expires: creds.expires,
  projectId: creds.projectId,
  email: creds.email,
});

const token = refreshed.access;
const projectId = refreshed.projectId || creds.projectId;
const endpoint = "https://cloudcode-pa.googleapis.com";

function headers() {
  return {
    ...mod.antigravityHeaders(token),
    Accept: "application/json",
  };
}

async function post(path, body) {
  const res = await fetch(`${endpoint}${path}`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text.slice(0, 3000) };
  }
  return { status: res.status, data };
}

// Redact secrets for dumps
function sanitize(value) {
  return JSON.parse(
    JSON.stringify(value, (k, v) =>
      /token|auth|secret|email|credential|noticeText|privacy/i.test(String(k))
        ? "[redacted]"
        : v,
    ),
  );
}

const bodies = {
  minimal: { metadata: { ideType: "ANTIGRAVITY" } },
  full: {
    metadata: {
      ideType: "ANTIGRAVITY",
      platform: "PLATFORM_UNSPECIFIED",
      pluginType: "GEMINI",
    },
  },
  geminiCli: {
    metadata: {
      ideType: "IDE_UNSPECIFIED",
      platform: "PLATFORM_UNSPECIFIED",
      pluginType: "GEMINI",
    },
  },
  vscode: {
    metadata: {
      ideType: "VSCODE",
      platform: "DARWIN",
      pluginType: "GEMINI",
    },
  },
  cloudCode: {
    metadata: {
      ideType: "CLOUD_CODE",
      platform: "PLATFORM_UNSPECIFIED",
      pluginType: "GEMINI",
    },
  },
};

const out = {
  authEmail: creds.email,
  projectId,
  loadCodeAssist: {},
  retrieveUserQuotaSummary: null,
  retrieveUserQuota: null,
  fetchAvailableModels: null,
  onboardUserVariants: {},
};

for (const [name, body] of Object.entries(bodies)) {
  out.loadCodeAssist[name] = sanitize(await post("/v1internal:loadCodeAssist", body));
}

out.retrieveUserQuotaSummary = sanitize(
  await post("/v1internal:retrieveUserQuotaSummary", {}),
);
out.retrieveUserQuota = sanitize(await post("/v1internal:retrieveUserQuota", {}));
out.fetchAvailableModels = sanitize(
  await post("/v1internal:fetchAvailableModels", { project: projectId }),
);

// Try onboardUser variants commonly used by community clients
const onboardBodies = [
  {
    name: "tierId-free",
    body: {
      tierId: "free-tier",
      metadata: {
        ideType: "ANTIGRAVITY",
        platform: "PLATFORM_UNSPECIFIED",
        pluginType: "GEMINI",
      },
      cloudaicompanionProject: projectId,
    },
  },
  {
    name: "tierId-legacy-standard",
    body: {
      tierId: "legacy-standard-tier",
      metadata: {
        ideType: "ANTIGRAVITY",
        platform: "PLATFORM_UNSPECIFIED",
        pluginType: "GEMINI",
      },
    },
  },
  {
    name: "empty",
    body: {},
  },
];

for (const item of onboardBodies) {
  out.onboardUserVariants[item.name] = sanitize(
    await post("/v1internal:onboardUser", item.body),
  );
}

// Extract tier-related fields clearly
function extractTier(resp) {
  const d = resp?.data || {};
  return {
    status: resp?.status,
    currentTier: d.currentTier,
    paidTier: d.paidTier,
    allowedTiers: d.allowedTiers,
    planInfo: d.planInfo,
    availablePromptCredits: d.availablePromptCredits,
    gcpManaged: d.gcpManaged,
    cloudaicompanionProject: d.cloudaicompanionProject,
    keys: Object.keys(d || {}),
  };
}

const summary = {
  authEmail: creds.email,
  projectId,
  loadCodeAssistTiers: Object.fromEntries(
    Object.entries(out.loadCodeAssist).map(([k, v]) => [k, extractTier(v)]),
  ),
  quotaSummaryGroups: (out.retrieveUserQuotaSummary?.data?.groups || []).map((g) => ({
    displayName: g.displayName,
    buckets: (g.buckets || []).map((b) => ({
      bucketId: b.bucketId,
      displayName: b.displayName,
      remainingFraction: b.remainingFraction,
      resetTime: b.resetTime,
    })),
  })),
  quotaSummaryTopKeys: Object.keys(out.retrieveUserQuotaSummary?.data || {}),
  fetchModelsDefault: out.fetchAvailableModels?.data?.defaultAgentModelId,
  fetchModelsCount: Object.keys(out.fetchAvailableModels?.data?.models || {}).length,
  onboard: Object.fromEntries(
    Object.entries(out.onboardUserVariants).map(([k, v]) => [
      k,
      { status: v.status, keys: Object.keys(v.data || {}), data: v.data },
    ]),
  ),
};

writeFileSync(
  "/Users/rahularya/Projects/tools/pi-antigravity/scripts/probe-tier-results.json",
  JSON.stringify(sanitize(out), null, 2),
);
console.log(JSON.stringify(summary, null, 2));
