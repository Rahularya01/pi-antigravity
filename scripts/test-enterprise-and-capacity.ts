import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import { checkPublicUrl } from "../src/utils/address.js";
import {
  enterpriseStreamUrl,
  resolveEnterpriseTarget,
  toEnterpriseGenerateBody,
} from "../src/client/enterprise.js";
import { advertisedSiblingRuntimes, siblingRuntimeModels } from "../src/models/models.js";
import { isGenericResourceExhausted, streamAntigravity } from "../src/stream/stream.js";
import { ANTIGRAVITY_MODELS } from "../src/models/index.js";
import type { AntigravityGenerateRequest } from "../src/types/types.js";

const home = mkdtempSync(join(tmpdir(), "antigravity-home-"));
const saved = {
  HOME: process.env.HOME,
  USERPROFILE: process.env.USERPROFILE,
  NO_PREWARM: process.env.ANTIGRAVITY_NO_PREWARM,
  LOCATION: process.env.ANTIGRAVITY_LOCATION,
  ENTERPRISE: process.env.ANTIGRAVITY_ENTERPRISE,
  PROJECT: process.env.ANTIGRAVITY_ENTERPRISE_PROJECT,
  TIER: process.env.ANTIGRAVITY_USER_TIER,
};
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.ANTIGRAVITY_NO_PREWARM = "1";
delete process.env.ANTIGRAVITY_LOCATION;
delete process.env.ANTIGRAVITY_ENTERPRISE;
delete process.env.ANTIGRAVITY_ENTERPRISE_PROJECT;
delete process.env.ANTIGRAVITY_USER_TIER;

assert.equal(resolveEnterpriseTarget(), undefined);
process.env.ANTIGRAVITY_LOCATION = "eu";
assert.throws(() => resolveEnterpriseTarget(), /consumer endpoint/);
process.env.ANTIGRAVITY_ENTERPRISE_PROJECT = "not a project";
assert.throws(() => resolveEnterpriseTarget(), /project id/);
process.env.ANTIGRAVITY_ENTERPRISE_PROJECT = "enterprise-project-1";
assert.throws(() => resolveEnterpriseTarget(), /USER_TIER/);
process.env.ANTIGRAVITY_USER_TIER = "gcp-ge-standard";
const target = resolveEnterpriseTarget();
assert.ok(target);
assert.equal(target?.host, "https://businessaicode.eu.rep.googleapis.com");
assert.equal(
  enterpriseStreamUrl(target!),
  "https://businessaicode.eu.rep.googleapis.com/v1beta/projects/enterprise-project-1/locations/eu:streamGenerateContent?alt=sse",
);
const envelope = {
  project: "consumer-project",
  model: "gemini-3.8-flash-high",
  request: {
    contents: [{ role: "user", parts: [{ text: "hi" }] }],
    systemInstruction: { role: "user", parts: [{ text: "sys" }] },
    sessionId: "secret-session",
  },
  requestType: "agent",
  userAgent: "antigravity",
  requestId: "req",
} as AntigravityGenerateRequest;
const enterpriseBody = toEnterpriseGenerateBody(envelope, target!);
assert.equal("project" in enterpriseBody, false);
assert.equal("sessionId" in (enterpriseBody as { request?: object }), false);
assert.deepEqual(enterpriseBody.aicode, { experience: "gemini-3.8-flash-high" });
assert.deepEqual(enterpriseBody.entitlement, { userTier: "gcp-ge-standard" });
assert.equal((enterpriseBody as { contents?: unknown }).contents, envelope.request.contents);
delete process.env.ANTIGRAVITY_LOCATION;
delete process.env.ANTIGRAVITY_ENTERPRISE_PROJECT;
delete process.env.ANTIGRAVITY_USER_TIER;

assert.deepEqual(siblingRuntimeModels("gemini-3.8-flash-low").slice(0, 2), [
  "gemini-3.8-flash-high",
  "gemini-3.8-flash-medium",
]);
assert.ok(advertisedSiblingRuntimes("gemini-3.8-flash-low").includes("gemini-3.8-flash-high"));
assert.deepEqual(siblingRuntimeModels("gemini-4-argon-high").slice(0, 1), ["gemini-4-argon-medium"]);
assert.deepEqual(siblingRuntimeModels("gemini-4-hydrogen-xhigh").slice(0, 2), [
  "gemini-4-hydrogen-high",
  "gemini-4-hydrogen-medium",
]);
assert.equal(isGenericResourceExhausted("Resource has been exhausted (e.g. check quota)."), true);
assert.equal(isGenericResourceExhausted("Quota exceeded. Resets in 2h"), false);
assert.equal(checkPublicUrl("http://127.1/").ok, false);
assert.equal(checkPublicUrl("http://0x7f000001/").ok, false);
assert.equal(checkPublicUrl("https://example.com/docs").ok, true);

const savedFetch = globalThis.fetch;
const model = {
  ...ANTIGRAVITY_MODELS.find((entry) => entry.id === "gemini-3.8-flash"),
  api: "antigravity",
  provider: "antigravity",
} as Model<Api>;
const options = {
  apiKey: JSON.stringify({ token: "test-token", projectId: "test-project" }),
  sessionId: "capacity-test",
};
try {
  const seen: { url: string; model?: string; marker?: string }[] = [];
  globalThis.fetch = (async (url, init) => {
    const payload = JSON.parse(String(init?.body)) as { model?: string; marker?: string };
    seen.push({ url: String(url), model: payload.model, marker: payload.marker });
    if (payload.model !== "gemini-3.8-flash-high") {
      return new Response(
        JSON.stringify({
          error: { message: "Resource has been exhausted (e.g. check quota).", status: "RESOURCE_EXHAUSTED" },
        }),
        { status: 429 },
      );
    }
    assert.equal(payload.marker, "from-extension");
    return new Response(
      'data: {"response":{"candidates":[{"content":{"parts":[{"text":"ok"}]},"finishReason":"STOP"}]}}\n\ndata: [DONE]\n\n',
    );
  }) as typeof fetch;
  const result = await streamAntigravity(
    model,
    { messages: [{ role: "user", content: "hi", timestamp: 1 }] },
    {
      ...options,
      reasoning: "off",
      onPayload: (payload) => ({ ...(payload as object), marker: "from-extension" }),
    },
  ).result();
  assert.equal(result.stopReason, "stop", result.errorMessage);
  assert.ok(
    seen.some((call) => call.model === "gemini-3.8-flash-low"),
    `expected a low-tier attempt, saw ${JSON.stringify(seen)}`,
  );
  assert.ok(
    seen.some((call) => call.model === "gemini-3.8-flash-high" && call.marker === "from-extension"),
    `expected a high-tier retry, saw ${JSON.stringify(seen)}`,
  );
  assert.ok(seen.every((call) => !String(call.url).includes("businessaicode")));
  assert.ok(seen.every((call) => call.marker === "from-extension"));

  process.env.ANTIGRAVITY_LOCATION = "eu";
  process.env.ANTIGRAVITY_ENTERPRISE_PROJECT = "enterprise-project-1";
  process.env.ANTIGRAVITY_USER_TIER = "gcp-ge-standard";
  const enterpriseCalls: string[] = [];
  globalThis.fetch = (async (url, init) => {
    enterpriseCalls.push(String(url));
    const payload = JSON.parse(String(init?.body)) as { aicode?: { experience?: string }; project?: string };
    assert.equal(payload.project, undefined);
    assert.equal(payload.aicode?.experience, "gemini-3.8-flash-high");
    const headers = new Headers(init?.headers);
    assert.match(headers.get("user-agent") || headers.get("User-Agent") || "", /auth_method=gcp/);
    return new Response(
      'data: {"response":{"candidates":[{"content":{"parts":[{"text":"eu"}]},"finishReason":"STOP"}]}}\n\ndata: [DONE]\n\n',
    );
  }) as typeof fetch;
  const regional = await streamAntigravity(
    model,
    { messages: [{ role: "user", content: "hi", timestamp: 1 }] },
    { ...options, reasoning: "high" },
  ).result();
  assert.equal(regional.stopReason, "stop", regional.errorMessage);
  assert.equal(enterpriseCalls.length, 1);
  assert.match(enterpriseCalls[0] || "", /^https:\/\/businessaicode\.eu\.rep\.googleapis\.com\/v1beta\/projects\/enterprise-project-1\/locations\/eu:streamGenerateContent/);
} finally {
  globalThis.fetch = savedFetch;
  for (const [key, value] of Object.entries({
    HOME: saved.HOME,
    USERPROFILE: saved.USERPROFILE,
    ANTIGRAVITY_NO_PREWARM: saved.NO_PREWARM,
    ANTIGRAVITY_LOCATION: saved.LOCATION,
    ANTIGRAVITY_ENTERPRISE: saved.ENTERPRISE,
    ANTIGRAVITY_ENTERPRISE_PROJECT: saved.PROJECT,
    ANTIGRAVITY_USER_TIER: saved.TIER,
  })) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

console.log("enterprise routing, sibling capacity fallback, and onPayload passed");
