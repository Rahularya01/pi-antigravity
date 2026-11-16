/** Self-check for the consumer 429 prompt guard (#137). */
import assert from "node:assert/strict";
import { applyPromptGuard } from "../src/stream/stream.js";
import type { AntigravityGenerateRequest, GeminiContent } from "../src/types/types.js";

function payload(contents: GeminiContent[], system: string): AntigravityGenerateRequest {
  return {
    project: "test-project",
    model: "gemini-3.8-flash",
    requestType: "agent",
    userAgent: "antigravity",
    requestId: "agent/test/0",
    request: {
      contents,
      systemInstruction: { role: "user", parts: [{ text: system }] },
    },
  };
}

delete process.env.ANTIGRAVITY_PROMPT_GUARD;
delete process.env.NOAGY_PROMPT_GUARD;

const normal = payload([{ role: "user", parts: [{ text: "say hi" }] }], "You are Pi.");
// The guard rewrites the payload in place, so snapshot the prompt before calling it.
const originalSystem = normal.request.systemInstruction.parts[0].text;
const guarded = applyPromptGuard(normal);
assert.equal(guarded.request.contents.length, 1, "no extra turn is inserted");
const retainedSystem = guarded.request.systemInstruction.parts;
assert.equal(retainedSystem.length, 1, "one short system line is retained");
assert.ok(retainedSystem[0].text.trim().length > 0, "the retained line is non-empty");
assert.ok(retainedSystem[0].text.length < 200, "the retained line stays short");
assert.notEqual(
  retainedSystem[0].text,
  originalSystem,
  "the original system prompt is removed from systemInstruction",
);
assert.deepEqual(
  guarded.request.contents[0].parts,
  [{ text: "[Operating instructions]\nYou are Pi.\n\nsay hi" }],
  "prompt is carried in the first user turn, original text intact",
);

const empty = applyPromptGuard(payload([], "You are Pi."));
assert.equal(empty.request.contents.length, 1, "a user turn is created when contents are empty");
assert.deepEqual(empty.request.contents[0].parts, [
  { text: "[Operating instructions]\nYou are Pi." },
]);

const toolTurn = payload(
  [{ role: "user", parts: [{ functionResponse: { name: "bash", response: { output: "ok" } } }] }],
  "You are Pi.",
);
applyPromptGuard(toolTurn);
assert.equal(toolTurn.request.contents[0].parts.length, 2, "tool-result part survives relocation");
assert.deepEqual(toolTurn.request.contents[0].parts[1], {
  functionResponse: { name: "bash", response: { output: "ok" } },
});

const blank = applyPromptGuard(payload([{ role: "user", parts: [{ text: "hi" }] }], "  "));
assert.deepEqual(blank.request.contents[0].parts, [{ text: "hi" }], "empty prompt is a no-op");

process.env.ANTIGRAVITY_PROMPT_GUARD = "off";
const off = payload([{ role: "user", parts: [{ text: "say hi" }] }], "You are Pi.");
assert.equal(applyPromptGuard(off), off, "kill switch returns the payload untouched");
assert.deepEqual(off.request.systemInstruction.parts, [{ text: "You are Pi." }]);
assert.deepEqual(off.request.contents[0].parts, [{ text: "say hi" }]);

console.log("test-prompt-guard: ok");
