/**
 * Live smoke: hit every registered public model with a tiny prompt.
 * Usage: node --import tsx scripts/smoke-all-models.mjs
 *        FILTER=gemini-3.5-flash node --import tsx scripts/smoke-all-models.mjs
 *        CONCURRENCY=2 TIMEOUT_MS=45000 node --import tsx scripts/smoke-all-models.mjs
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const authPath = process.env.PI_AUTH_PATH || `${process.env.HOME}/.pi/agent/auth.json`;

let auth;
try {
  auth = JSON.parse(readFileSync(authPath, "utf8"));
} catch (err) {
  console.error(`Failed to read/parse auth file ${authPath}: ${err?.message || err}`);
  process.exit(1);
}
const creds = auth?.antigravity;
if (!creds?.refresh) {
  console.error(`No antigravity credentials in ${authPath}`);
  process.exit(1);
}

const oauth = await import(pathToFileURL(join(root, "src/auth/oauth.ts")).href);
const client = await import(pathToFileURL(join(root, "src/client/client.ts")).href);
const utils = await import(pathToFileURL(join(root, "src/utils/util.ts")).href);
const models = await import(pathToFileURL(join(root, "src/models/models.ts")).href);

const CONCURRENCY = Math.max(1, Number(process.env.CONCURRENCY || 2));
const TIMEOUT_MS = Math.max(5000, Number(process.env.TIMEOUT_MS || 60_000));
const FILTER = (process.env.FILTER || "").trim();
const PROMPT = process.env.PROMPT || "Reply with exactly one word: pong";

console.log(`email=${creds.email || "none"} projectId(auth)=${creds.projectId || "none"}`);

const refreshed = await oauth.refreshAntigravityToken({
  refresh: creds.refresh,
  access: creds.access,
  expires: creds.expires,
  projectId: creds.projectId,
  email: creds.email,
});
console.log(`refresh=ok projectId(refreshed)=${refreshed.projectId || "none"}`);

const projectId = refreshed.projectId || creds.projectId || client.DEFAULT_PROJECT_ID;
const endpoint = client.endpointCandidates()[0];
console.log(`endpoint=${endpoint}`);

// Optional: list available runtime models for diagnostics
let availableIds = [];
try {
  const availRes = await fetch(`${endpoint}/v1internal:fetchAvailableModels`, {
    method: "POST",
    headers: {
      ...client.antigravityHeaders(refreshed.access),
      Accept: "application/json",
    },
    body: JSON.stringify({ project: projectId }),
  });
  const availJson = await availRes.json().catch(() => ({}));
  availableIds = Object.keys(availJson.models || {});
  console.log(`availableRuntimeModels=${availableIds.length} status=${availRes.status}`);
  if (availableIds.length) {
    console.log(`  sample: ${availableIds.slice(0, 12).join(", ")}${availableIds.length > 12 ? " ..." : ""}`);
  }
} catch (err) {
  console.log(`fetchAvailableModels failed: ${err?.message || err}`);
}

const allModels = models.ANTIGRAVITY_MODELS.map((m) => m.id);
const selected = FILTER
  ? allModels.filter((id) => id.includes(FILTER) || FILTER.split(",").includes(id))
  : allModels;

if (!selected.length) {
  console.error(`No models matched FILTER=${FILTER}`);
  process.exit(1);
}

console.log(`\nTesting ${selected.length}/${allModels.length} models (concurrency=${CONCURRENCY})\n`);

function parseSseText(text) {
  const parts = [];
  let finishReason;
  let promptFeedback;
  for (const line of text.split("\n")) {
    if (!line.startsWith("data:")) continue;
    const json = line.slice(5).trim();
    if (!json || json === "[DONE]") continue;
    try {
      const chunk = JSON.parse(json);
      if (chunk.response?.promptFeedback) promptFeedback = chunk.response.promptFeedback;
      for (const cand of chunk.response?.candidates || []) {
        if (cand.finishReason) finishReason = cand.finishReason;
        for (const p of cand.content?.parts || []) {
          if (typeof p.text === "string" && p.text.length) {
            parts.push({ thought: !!p.thought, text: p.text });
          }
        }
      }
      // Some error payloads nest under error
      if (chunk.error) {
        parts.push({ thought: false, text: "", error: chunk.error });
      }
    } catch {
      // ignore partial
    }
  }
  return { parts, finishReason, promptFeedback };
}

async function smokeOne(publicId) {
  const runtimeModel = models.getAntigravityRequestModelId(publicId, "off");
  const isClaude = publicId.startsWith("claude-") || runtimeModel.startsWith("claude-");
  const body = {
    project: projectId,
    model: runtimeModel,
    request: {
      contents: [{ role: "user", parts: [{ text: PROMPT }] }],
      generationConfig: { maxOutputTokens: 256 },
    },
    requestType: "agent",
    userAgent: "antigravity",
    requestId: utils.nowRequestId(),
  };

  const headers = {
    ...client.antigravityHeaders(refreshed.access),
    ...(isClaude ? { "anthropic-beta": "interleaved-thinking-2025-05-14" } : {}),
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const started = Date.now();
  try {
    const res = await fetch(`${endpoint}/v1internal:streamGenerateContent?alt=sse`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await res.text();
    const ms = Date.now() - started;
    if (!res.ok) {
      return {
        publicId,
        runtimeModel,
        ok: false,
        status: res.status,
        ms,
        error: text.slice(0, 500),
      };
    }
    const { parts, finishReason, promptFeedback } = parseSseText(text);
    const joined = parts
      .filter((p) => !p.error)
      .map((p) => p.text)
      .join("");
    const hasPong = /pong/i.test(joined);
    const hasText = joined.trim().length > 0;
    const errPart = parts.find((p) => p.error);
    return {
      publicId,
      runtimeModel,
      ok: hasPong || hasText,
      status: res.status,
      ms,
      hasPong,
      hasText,
      finishReason,
      promptFeedback,
      joined: joined.slice(0, 200),
      error: errPart ? JSON.stringify(errPart.error).slice(0, 400) : undefined,
    };
  } catch (err) {
    return {
      publicId,
      runtimeModel,
      ok: false,
      status: 0,
      ms: Date.now() - started,
      error: err?.name === "AbortError" ? `timeout after ${TIMEOUT_MS}ms` : String(err?.message || err),
    };
  } finally {
    clearTimeout(timer);
  }
}

async function mapPool(items, limit, fn) {
  const results = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      const item = items[idx];
      process.stdout.write(`→ ${item} ...\n`);
      results[idx] = await fn(item);
      const r = results[idx];
      const mark = r.ok ? "OK " : "FAIL";
      console.log(
        `  ${mark} ${r.publicId} → ${r.runtimeModel} status=${r.status} ${r.ms}ms` +
          (r.ok ? ` text=${JSON.stringify(r.joined)}` : ` err=${JSON.stringify(r.error || "").slice(0, 180)}`),
      );
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}

const results = await mapPool(selected, CONCURRENCY, smokeOne);

const passed = results.filter((r) => r.ok);
const failed = results.filter((r) => !r.ok);

const outPath = join(__dirname, "smoke-all-models-results.json");
writeFileSync(
  outPath,
  JSON.stringify(
    {
      at: new Date().toISOString(),
      email: creds.email,
      projectId,
      endpoint,
      availableRuntimeModels: availableIds,
      concurrency: CONCURRENCY,
      timeoutMs: TIMEOUT_MS,
      results,
      summary: { total: results.length, passed: passed.length, failed: failed.length },
    },
    null,
    2,
  ),
);

console.log("\n========== SUMMARY ==========");
console.log(`passed ${passed.length}/${results.length}`);
if (passed.length) {
  console.log("OK:");
  for (const r of passed) console.log(`  - ${r.publicId} → ${r.runtimeModel} (${r.ms}ms)`);
}
if (failed.length) {
  console.log("FAIL:");
  for (const r of failed) {
    console.log(`  - ${r.publicId} → ${r.runtimeModel} status=${r.status} ${r.error?.slice?.(0, 160) || r.error || ""}`);
  }
}
console.log(`wrote ${outPath}`);
process.exit(failed.length ? 2 : 0);
