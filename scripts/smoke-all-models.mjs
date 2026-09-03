/**
 * Live smoke: hit every registered public model with a tiny prompt.
 * Usage: bun scripts/smoke-all-models.mjs
 *        FILTER=gemini-3.5-flash bun scripts/smoke-all-models.mjs
 *        FILTER=gemini-3.8-flash EFFORT=high bun scripts/smoke-all-models.mjs
 *        CONCURRENCY=2 TIMEOUT_MS=45000 bun scripts/smoke-all-models.mjs
 */

const authPath = Bun.env.PI_AUTH_PATH || `${Bun.env.HOME ?? Bun.env.USERPROFILE}/.pi/agent/auth.json`;

let auth;
try {
  auth = await Bun.file(authPath).json();
} catch (err) {
  console.error(`Failed to read/parse auth file ${authPath}: ${err?.message || err}`);
  process.exit(1);
}
const creds = auth?.antigravity;
if (!creds?.refresh) {
  console.error(`No antigravity credentials in ${authPath}`);
  process.exit(1);
}

const oauth = await import("../src/auth/oauth.ts");
const client = await import("../src/client/client.ts");
const utils = await import("../src/utils/util.ts");
const models = await import("../src/models/models.ts");

const CONCURRENCY = Math.max(1, Number(Bun.env.CONCURRENCY || 2));
const TIMEOUT_MS = Math.max(5000, Number(Bun.env.TIMEOUT_MS || 60_000));
const FILTER = (Bun.env.FILTER || "").trim();
const EFFORT = (Bun.env.EFFORT || "off").trim().toLowerCase();
const PROMPT = Bun.env.PROMPT || "Reply with exactly one word: pong";

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
    console.log(
      `  sample: ${availableIds.slice(0, 12).join(", ")}${availableIds.length > 12 ? " ..." : ""}`,
    );
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

console.log(
  `\nTesting ${selected.length}/${allModels.length} models (concurrency=${CONCURRENCY})\n`,
);

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
  const initialRuntimeModel = models.getAntigravityRequestModelId(publicId, EFFORT);
  const candidates = [initialRuntimeModel];
  const fallback = models.getFallbackRuntimeModel?.(initialRuntimeModel, EFFORT);
  if (fallback && fallback !== initialRuntimeModel) candidates.push(fallback);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const started = Date.now();
  let runtimeModel = initialRuntimeModel;
  try {
    let res;
    let text = "";
    let usedEndpoint = endpoint;

    for (let i = 0; i < candidates.length; i++) {
      runtimeModel = candidates[i];
      const isClaude = publicId.startsWith("claude-") || runtimeModel.startsWith("claude-");
      const generationConfig: Record<string, unknown> = { maxOutputTokens: 256 };
      if (
        publicId === "gemini-3.8-flash" ||
        publicId === "gemini-3.7-flash" ||
        publicId === "gemini-3.6-flash"
      ) {
        generationConfig.thinkingConfig = {
          includeThoughts: true,
          thinkingLevel:
            EFFORT === "high" || EFFORT === "xhigh"
              ? "HIGH"
              : EFFORT === "medium"
                ? "MEDIUM"
                : "LOW",
        };
      }
      const body = {
        project: projectId,
        model: runtimeModel,
        request: {
          contents: [{ role: "user", parts: [{ text: PROMPT }] }],
          generationConfig,
        },
        requestType: "agent",
        userAgent: "antigravity",
        requestId: utils.nowRequestId(),
      };

      const headers = {
        ...client.antigravityHeaders(refreshed.access),
        ...(isClaude ? { "anthropic-beta": "interleaved-thinking-2025-05-14" } : {}),
      };

      for (const ep of client.endpointCandidates()) {
        usedEndpoint = ep;
        res = await fetch(`${ep}/v1internal:streamGenerateContent?alt=sse`, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        if (res.ok) break;
        text = await res.text();
        if (res.status === 429 && /Individual quota reached/i.test(text)) break;
        if (![403, 404, 429, 500, 502, 503, 504].includes(res.status)) break;
      }
      if (res?.ok) break;
      if (res?.status === 404 && i + 1 < candidates.length) continue;
      break;
    }

    const ms = Date.now() - started;
    if (!res || !res.ok) {
      return {
        publicId,
        runtimeModel,
        endpoint: usedEndpoint,
        ok: false,
        status: res?.status ?? 0,
        ms,
        error: text.slice(0, 500),
      };
    }
    text = await res.text();
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
      endpoint: usedEndpoint,
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
      error:
        err?.name === "AbortError" ? `timeout after ${TIMEOUT_MS}ms` : String(err?.message || err),
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
      console.log(`→ ${item} ...`);
      results[idx] = await fn(item);
      const r = results[idx];
      const mark = r.ok ? "OK " : "FAIL";
      console.log(
        `  ${mark} ${r.publicId} → ${r.runtimeModel} status=${r.status} ${r.ms}ms` +
          (r.ok
            ? ` text=${JSON.stringify(r.joined)}`
            : ` err=${JSON.stringify(r.error || "").slice(0, 180)}`),
      );
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}

const results = await mapPool(selected, CONCURRENCY, smokeOne);

const passed = results.filter((r) => r.ok);
const failed = results.filter((r) => !r.ok);

const outPath = `${import.meta.dir}/smoke-all-models-results.json`;
await Bun.write(
  outPath,
  JSON.stringify(
    {
      at: new Date().toISOString(),
      email: creds.email,
      projectId,
      endpoint,
      availableRuntimeModels: availableIds,
      concurrency: CONCURRENCY,
      effort: EFFORT,
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
    console.log(
      `  - ${r.publicId} → ${r.runtimeModel} status=${r.status} ${r.error?.slice?.(0, 160) || r.error || ""}`,
    );
  }
}
console.log(`wrote ${outPath}`);
process.exit(failed.length ? 2 : 0);
