import assert from "node:assert/strict";
import { sanitizeText } from "../src/utils/util.js";

console.log("Running sanitizeText tests...");

// Preserves valid emojis (astral plane / surrogate pairs)
const emojis = "🐑 💼 🧳 🪓 📋 ✨ 🚀 ⚠️ 👍🏽";
assert.equal(sanitizeText(emojis), emojis, "valid emojis should be preserved");

// Preserves standard text
assert.equal(sanitizeText("hello world"), "hello world");
assert.equal(sanitizeText(""), "");
assert.equal(sanitizeText(123), "123");
assert.equal(sanitizeText(null), "");
assert.equal(sanitizeText(undefined), "");

// Replaces lone high surrogates
assert.equal(
  sanitizeText("start\uD800end"),
  "start\uFFFDend",
  "lone high surrogate should be replaced with U+FFFD",
);

// Replaces lone low surrogates
assert.equal(
  sanitizeText("start\uDC00end"),
  "start\uFFFDend",
  "lone low surrogate should be replaced with U+FFFD",
);

// Handles mixed strings with valid emojis and lone surrogates
assert.equal(
  sanitizeText("🐑\uD800💼\uDC00🧳"),
  "🐑\uFFFD💼\uFFFD🧳",
  "valid surrogate pairs should remain intact while lone surrogates are replaced",
);

console.log("sanitizeText tests passed!");
