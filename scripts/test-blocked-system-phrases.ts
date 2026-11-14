import assert from "node:assert/strict";
import { neutralizeBlockedSystemPhrases } from "../src/stream/stream.js";

console.log("Running blocked system phrase tests...");

// Pi's default preamble is the phrase that trips the 429 for requestType:"agent".
const PI_PREAMBLE =
  "You are a coding assistant running inside pi, a coding agent harness. " +
  "Help users inspect files, run commands, and modify code.";

const rewritten = neutralizeBlockedSystemPhrases(PI_PREAMBLE);
assert.ok(
  !/inside pi/i.test(rewritten),
  "the rejected phrase from Pi's preamble must not survive",
);
assert.ok(
  rewritten.includes("coding assistant running in pi"),
  "the rewrite should keep the sentence readable",
);
assert.ok(
  rewritten.includes("Help users inspect files, run commands, and modify code."),
  "text after the rewrite point must be preserved",
);

// Case-insensitive, matching the backend's own matching.
for (const variant of [
  "You are a coding assistant running inside pi.",
  "You are a coding assistant RUNNING INSIDE PI.",
  "you are a coding assistant Running Inside Pi.",
]) {
  assert.ok(
    !/running inside pi/i.test(neutralizeBlockedSystemPhrases(variant)),
    `case variant should be rewritten: ${variant}`,
  );
}

// The plugin's own default instruction ends with the second blocked phrase.
assert.ok(
  !/tool-aware\./i.test(
    neutralizeBlockedSystemPhrases("Be concise, practical, and tool-aware."),
  ),
  "the hardcoded preamble tail must be neutralized too",
);

// Unrelated text must pass through untouched.
for (const safe of [
  "You are a helpful assistant.",
  "You are a coding agent. Answer concisely.",
  "You are a coding assistant inside pi.",
  "",
]) {
  assert.equal(
    neutralizeBlockedSystemPhrases(safe),
    safe,
    `safe text must be unchanged: ${JSON.stringify(safe)}`,
  );
}

// The whole real preamble is idempotent on a second pass.
const once = neutralizeBlockedSystemPhrases(PI_PREAMBLE);
assert.equal(
  neutralizeBlockedSystemPhrases(once),
  once,
  "neutralizing twice must be a no-op",
);

// Concrete diff the backend needs: `requestType:"agent"` + the original preamble
// answers 429, while the rewritten preamble answers 200.
assert.notEqual(
  neutralizeBlockedSystemPhrases(PI_PREAMBLE),
  PI_PREAMBLE,
  "the emitted systemInstruction must actually differ from the rejected one",
);

console.log("Blocked system phrase tests passed!");
