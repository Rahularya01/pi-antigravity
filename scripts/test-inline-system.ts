import assert from "node:assert/strict";
import type { Api, Context, Model } from "@earendil-works/pi-ai";
import {
  buildRequest,
  inlineSystemInstruction,
  inlineSystemPreference,
  isInlineSystemEnabled,
  shouldInlineSystem,
} from "../src/stream/stream.ts";

/**
 * `ANTIGRAVITY_INLINE_SYSTEM` folds the system prompt into the first user turn and omits
 * `systemInstruction`. Some consumer endpoints answer a `systemInstruction` part of 127
 * characters or more with a bogus 429 RESOURCE_EXHAUSTED; the same text inside `contents`
 * is accepted at any length. A real Pi system prompt is far longer than the cap, so an
 * affected account cannot use the provider without this workaround.
 */

const model = {
  id: "gemini-3.8-flash",
  name: "Gemini 3.8 Flash",
  api: "antigravity",
  provider: "antigravity",
  baseUrl: "",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1_000_000,
  maxTokens: 65_536,
} as unknown as Model<Api>;

const SYSTEM_TEXT = "You are a coding assistant. Be concise.";

function contextWithUserTurn(): Context {
  return {
    messages: [
      { role: "system", content: SYSTEM_TEXT, timestamp: Date.now() },
      { role: "user", content: "hello", timestamp: Date.now() },
    ],
  } as unknown as Context;
}

/**
 * `antigravityEnv()` falls back to the legacy `NOAGY_` prefix, so an inherited value on
 * either variable would silently decide the wire shape. Save and clear both.
 */
const savedEnv = {
  ANTIGRAVITY_INLINE_SYSTEM: process.env.ANTIGRAVITY_INLINE_SYSTEM,
  NOAGY_INLINE_SYSTEM: process.env.NOAGY_INLINE_SYSTEM,
};

function clearInlineSystemEnv(): void {
  delete process.env.ANTIGRAVITY_INLINE_SYSTEM;
  delete process.env.NOAGY_INLINE_SYSTEM;
}

function restoreInlineSystemEnv(): void {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

clearInlineSystemEnv();

// --- flag parsing -----------------------------------------------------------

clearInlineSystemEnv();
assert.equal(isInlineSystemEnabled(), false, "inline system is opt-in");

for (const on of ["1", "true", "TRUE", "on", " On "]) {
  process.env.ANTIGRAVITY_INLINE_SYSTEM = on;
  assert.equal(isInlineSystemEnabled(), true, `"${on}" enables inline system`);
}

for (const off of ["0", "false", "off"]) {
  process.env.ANTIGRAVITY_INLINE_SYSTEM = off;
  assert.equal(isInlineSystemEnabled(), false, `"${off}" disables inline system`);
  assert.equal(inlineSystemPreference(), "off", `"${off}" is an explicit native override`);
}

for (const auto of ["", "  ", "no", "2", "auto"]) {
  process.env.ANTIGRAVITY_INLINE_SYSTEM = auto;
  assert.equal(isInlineSystemEnabled(), false, `"${auto}" does not force inline`);
  assert.equal(inlineSystemPreference(), "auto", `"${auto}" leaves the decision to the cap`);
}

// Legacy prefix: NOAGY_INLINE_SYSTEM behaves like the ANTIGRAVITY_ form.
clearInlineSystemEnv();
process.env.NOAGY_INLINE_SYSTEM = "1";
assert.equal(isInlineSystemEnabled(), true, "legacy NOAGY_ prefix forces inline");
process.env.NOAGY_INLINE_SYSTEM = "0";
assert.equal(inlineSystemPreference(), "off", "legacy NOAGY_ prefix can disable inline");

// --- default path is untouched ---------------------------------------------

clearInlineSystemEnv();
// A short prompt fits the per-part cap, so the wire-native shape is kept.
assert.ok(SYSTEM_TEXT.length <= 126, "fixture stays under the cap");
const defaultReq = buildRequest(model, contextWithUserTurn(), "test-project", {}, "gemini-3.8-flash");
assert.ok(defaultReq.request.systemInstruction, "short prompt keeps systemInstruction");
assert.deepEqual(
  defaultReq.request.systemInstruction?.parts.map((part) => part.text),
  [SYSTEM_TEXT],
  "short prompt stays in systemInstruction",
);
assert.equal(
  defaultReq.request.contents.some((turn) =>
    turn.parts.some((part) => "text" in part && part.text === SYSTEM_TEXT),
  ),
  false,
  "default does not duplicate the prompt into contents",
);


// A real Pi system prompt exceeds the per-part cap by an order of magnitude; the inline
// path must not silently drop it or leave any part behind in systemInstruction.
const longSystem = "You are a coding assistant. ".repeat(80); // ~2480 chars
const longContext = {
  messages: [
    { role: "system", content: longSystem, timestamp: Date.now() },
    { role: "user", content: "hi", timestamp: Date.now() },
  ],
} as unknown as Context;
// Without any opt-in, a prompt above the cap is folded automatically.
clearInlineSystemEnv();
assert.equal(isInlineSystemEnabled(), false, "auto-fold does not need the env var");
assert.equal(shouldInlineSystem([{ text: longSystem }]), true, "long prompt auto-folds");
assert.equal(shouldInlineSystem([{ text: "x".repeat(126) }]), false, "126 chars stays inline");
assert.equal(shouldInlineSystem([{ text: "x".repeat(127) }]), true, "127 chars folds");
const longInline = buildRequest(model, longContext, "test-project", {}, "gemini-3.8-flash");
assert.equal(
  "systemInstruction" in longInline.request,
  false,
  "long prompt: systemInstruction omitted without opt-in",
);

// An explicit native override wins over the length check, for every disable spelling.
// Sending an oversized part then fails upstream with the 429 documented above; that is
// the operator's choice, and the assertion documents which shape reaches the wire.
for (const off of ["0", "false", "off"]) {
  process.env.ANTIGRAVITY_INLINE_SYSTEM = off;
  assert.equal(
    shouldInlineSystem([{ text: longSystem }]),
    false,
    `"${off}" keeps native placement for an oversized prompt`,
  );
  const nativeLong = buildRequest(model, longContext, "test-project", {}, "gemini-3.8-flash");
  assert.ok(
    nativeLong.request.systemInstruction,
    `"${off}" keeps the systemInstruction field`,
  );
  assert.equal(
    nativeLong.request.systemInstruction?.parts[0]?.text,
    longSystem,
    `"${off}" keeps the prompt in systemInstruction`,
  );
}
clearInlineSystemEnv();

// Every part is measured: a long skill block appended after a short prompt must also fold.
const longSkill = `<skill name="big">${"detail ".repeat(50)}</skill>`;
assert.equal(
  shouldInlineSystem([{ text: SYSTEM_TEXT }, { text: longSkill }]),
  true,
  "oversized trailing skill block triggers folding",
);
assert.equal(
  shouldInlineSystem([{ text: SYSTEM_TEXT }, { text: "short skill" }]),
  false,
  "short trailing parts do not force folding",
);
assert.equal("systemInstruction" in longInline.request, false, "long prompt: field omitted");
const longFirstPart = longInline.request.contents[0]?.parts[0];
assert.ok(longFirstPart && "text" in longFirstPart, "long prompt occupies a text part");
assert.equal(
  "text" in longFirstPart ? longFirstPart.text.length : 0,
  longSystem.length,
  "long prompt survives intact in contents",
);

// --- inline path ------------------------------------------------------------

process.env.ANTIGRAVITY_INLINE_SYSTEM = "1";
const inlineReq = buildRequest(model, contextWithUserTurn(), "test-project", {}, "gemini-3.8-flash");
// (forced inline below)
assert.equal(
  "systemInstruction" in inlineReq.request,
  false,
  "inline path omits systemInstruction entirely (even empty parts trigger the 429)",
);
const firstTurn = inlineReq.request.contents[0];
assert.equal(firstTurn?.role, "user", "first turn stays a user turn");
assert.equal(firstTurn?.parts.length, 2, "prompt is prepended, existing part kept");
assert.deepEqual(firstTurn?.parts[0], { text: SYSTEM_TEXT }, "prompt text preserved verbatim");
assert.deepEqual(firstTurn?.parts[1], { text: "hello" }, "user text follows the prompt");

// Inline path must still carry tools, so tool calls keep working.
const toolsContext = {
  messages: [
    {
      role: "system",
      content: SYSTEM_TEXT,
      toolsAdded: [
        {
          name: "bash",
          description: "run a command",
          parameters: {
            type: "object",
            properties: { command: { type: "string", description: "Shell command" } },
            required: ["command"],
          },
        },
      ],
      timestamp: Date.now(),
    },
    { role: "user", content: "hi", timestamp: Date.now() },
  ],
} as unknown as Context;
const toolReq = buildRequest(model, toolsContext, "test-project", {}, "gemini-3.8-flash");
assert.equal("systemInstruction" in toolReq.request, false, "inline path with tools omits it");
assert.ok(toolReq.request.tools, "inline path with tools still declares them");

// --- inlineSystemInstruction() edge cases -----------------------------------

let turns = [{ role: "user", parts: [{ text: "hi" }] }];
inlineSystemInstruction(turns, [{ text: "SYS" }]);
assert.deepEqual(turns, [{ role: "user", parts: [{ text: "SYS" }, { text: "hi" }] }]);

// An injected placeholder is dropped, but only when the caller says it injected one.
const PLACEHOLDER = "Apply the active system instructions.";
turns = [{ role: "user", parts: [{ text: PLACEHOLDER }] }];
inlineSystemInstruction(turns, [{ text: "SYS" }], true);
assert.deepEqual(
  turns,
  [{ role: "user", parts: [{ text: "SYS" }] }],
  "injected placeholder turn is consumed rather than kept alongside the prompt",
);

// The same words typed by the user are a real message and must survive.
turns = [{ role: "user", parts: [{ text: PLACEHOLDER }] }];
inlineSystemInstruction(turns, [{ text: "SYS" }], false);
assert.deepEqual(
  turns,
  [{ role: "user", parts: [{ text: "SYS" }, { text: PLACEHOLDER }] }],
  "user-authored text that matches the placeholder text is preserved",
);

// End-to-end: buildRequest only drops the placeholder it injected itself.
const longSystemOnly = "You are a coding assistant. ".repeat(80);
const systemOnlyLong = buildRequest(
  model,
  { messages: [{ role: "system", content: longSystemOnly, timestamp: Date.now() }] } as unknown as Context,
  "test-project",
  {},
  "gemini-3.8-flash",
);
assert.equal(
  systemOnlyLong.request.contents.length,
  1,
  "injected placeholder is not left behind as an extra turn",
);
assert.equal(
  systemOnlyLong.request.contents[0]?.parts.length,
  1,
  "only the folded prompt remains in the single user turn",
);

const userTypedPlaceholder = buildRequest(
  model,
  {
    messages: [
      { role: "system", content: longSystemOnly, timestamp: Date.now() },
      { role: "user", content: PLACEHOLDER, timestamp: Date.now() },
    ],
  } as unknown as Context,
  "test-project",
  {},
  "gemini-3.8-flash",
);
assert.equal(
  userTypedPlaceholder.request.contents[0]?.parts.length,
  2,
  "user text identical to the placeholder text is preserved alongside the prompt",
);

turns = [{ role: "model", parts: [{ text: "m" }] }];
inlineSystemInstruction(turns, [{ text: "SYS" }]);
assert.deepEqual(
  turns[0],
  { role: "user", parts: [{ text: "SYS" }] },
  "no leading user turn -> a new one is unshifted",
);
assert.equal(turns.length, 2, "existing turns preserved after unshift");

turns = [];
inlineSystemInstruction(turns, [{ text: "SYS" }]);
assert.deepEqual(turns, [{ role: "user", parts: [{ text: "SYS" }] }]);

turns = [{ role: "user", parts: [{ text: "hi" }] }];
inlineSystemInstruction(turns, [{ text: "A" }, { text: "B" }]);
assert.deepEqual(
  turns,
  [{ role: "user", parts: [{ text: "A\n\nB" }, { text: "hi" }] }],
  "multiple system parts join into one block",
);

turns = [{ role: "user", parts: [{ text: "hi" }] }];
inlineSystemInstruction(turns, []);
assert.deepEqual(turns, [{ role: "user", parts: [{ text: "hi" }] }], "no system parts -> no-op");

// --- restore ----------------------------------------------------------------

restoreInlineSystemEnv();

console.log("scripts/test-inline-system.ts: all inline-system tests passed");
