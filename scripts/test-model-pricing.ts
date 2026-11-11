import assert from "node:assert/strict";
import {
  ANTIGRAVITY_DISCOVERED_MODEL_COSTS,
  ANTIGRAVITY_MODELS,
  getAntigravityModelCost,
} from "../src/models/index.js";

console.log("Running model pricing tests...");

const costOf = (id: string) => ANTIGRAVITY_MODELS.find((m) => m.id === id)?.cost;

// Every Flash model used to share one flat placeholder ($0.10 / $0.40 / $0.025),
// which understated Gemini usage by roughly 4-7x. Each model now carries its own
// published rate.
assert.deepEqual(costOf("gemini-3.8-flash"), {
  input: 0.75,
  output: 3.75,
  cacheRead: 0.075,
  cacheWrite: 0.75,
});
assert.deepEqual(costOf("gemini-3.7-flash"), {
  input: 0.75,
  output: 3.75,
  cacheRead: 0.075,
  cacheWrite: 0.75,
});
assert.deepEqual(costOf("gemini-3.6-flash"), {
  input: 0.75,
  output: 3.75,
  cacheRead: 0.075,
  cacheWrite: 0.75,
});
assert.deepEqual(costOf("gemini-3.5-flash"), {
  input: 1.5,
  output: 9.0,
  cacheRead: 0.15,
  cacheWrite: 1.5,
});
assert.deepEqual(costOf("gemini-3.1-pro"), {
  input: 2.0,
  output: 12.0,
  cacheRead: 0.2,
  cacheWrite: 2.0,
});

// No two Flash models may share a rate by accident.
const flashIds = ANTIGRAVITY_MODELS.filter((m) => /^gemini-.*-flash$/i.test(m.id)).map(
  (m) => m.id,
);
assert.ok(flashIds.length >= 2, "expected several Flash models to compare");
const flashRates = new Set(
  flashIds.map((id) => JSON.stringify(costOf(id))),
);
assert.ok(
  flashRates.size > 1,
  "Flash models should not all collapse to a single shared rate",
);

// Models that only appear through dynamic discovery are priced too.
assert.deepEqual(ANTIGRAVITY_DISCOVERED_MODEL_COSTS["gemini-2.5-flash"], {
  input: 0.3,
  output: 2.5,
  cacheRead: 0.03,
  cacheWrite: 0.3,
});
assert.deepEqual(getAntigravityModelCost("gemini-2.5-flash-lite"), {
  input: 0.1,
  output: 0.4,
  cacheRead: 0.01,
  cacheWrite: 0.1,
});

// A statically shipped model resolves through the same lookup.
assert.deepEqual(getAntigravityModelCost("gemini-3.8-flash"), costOf("gemini-3.8-flash"));

// An unpriced model must return undefined so callers fall back rather than
// publish a made-up number.
assert.equal(getAntigravityModelCost("totally-unknown-model"), undefined);

console.log("Model pricing tests passed!");
