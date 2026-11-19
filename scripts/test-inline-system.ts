import assert from "node:assert/strict";
import type { Api, Context, Model } from "@earendil-works/pi-ai";
import {
  buildRequest,
  inlineSystemInstruction,
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

const saved = process.env.ANTIGRAVITY_INLINE_SYSTEM;

// --- flag parsing -----------------------------------------------------------

delete process.env.ANTIGRAVITY_INLINE_SYSTEM;
assert.equal(isInlineSystemEnabled(), false, "inline system is opt-in");

for (const on of ["1", "true", "TRUE", "on", " On "]) {
  process.env.ANTIGRAVITY_INLINE_SYSTEM = on;
  assert.equal(isInlineSystemEnabled(), true, `"${on}" enables inline system`);
}

for (const off of ["0", "false", "off", "", "no", "2"]) {
  process.env.ANTIGRAVITY_INLINE_SYSTEM = off;
  assert.equal(isInlineSystemEnabled(), false, `"${off}" leaves the wire shape unchanged`);
}

// --- default path is untouched ---------------------------------------------

delete process.env.ANTIGRAVITY_INLINE_SYSTEM;
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
delete process.env.ANTIGRAVITY_INLINE_SYSTEM;
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

turns = [{ role: "user", parts: [{ text: "Apply the active system instructions." }] }];
inlineSystemInstruction(turns, [{ text: "SYS" }]);
assert.deepEqual(
  turns,
  [{ role: "user", parts: [{ text: "SYS" }] }],
  "placeholder turn is consumed rather than kept alongside the prompt",
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

if (saved === undefined) delete process.env.ANTIGRAVITY_INLINE_SYSTEM;
else process.env.ANTIGRAVITY_INLINE_SYSTEM = saved;

console.log("scripts/test-inline-system.ts: all inline-system tests passed");
