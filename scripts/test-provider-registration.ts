import assert from "node:assert/strict";
import register from "../src/index.js";

let registered: { id: string; config: { oauth?: { isSubscription?: boolean } } } | undefined;
let onStart: any;
const pi = new Proxy(
  {},
  {
    get(_target, prop) {
      if (prop === "on") return (event: string, handler: unknown) => { if (event === "session_start") onStart = handler; };
      if (prop === "registerProvider")
        return (id: string, config: { oauth?: { isSubscription?: boolean } }) => {
          registered = { id, config };
        };
      return () => undefined;
    },
  },
);
register(pi as Parameters<typeof register>[0]);

assert.equal(registered?.id, "antigravity");
assert.equal(
  registered?.config.oauth?.isSubscription,
  true,
  "Antigravity OAuth is marked subscription-backed so Pi shows the (sub) marker",
);

console.log("provider registration: subscription-backed oauth passed");

// Interactive startup returns while discovery is pending; headless waits for it.
const offline = process.env.PI_OFFLINE;
delete process.env.PI_OFFLINE;
try {
  for (const hasUI of [true, false]) {
    let release!: () => void;
    let finished = false;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const started = onStart({}, { hasUI, modelRegistry: { refresh: () => pending } }).then(() => { finished = true; });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(finished, hasUI);
    release();
    await started;
  }
  await onStart({}, { hasUI: true, modelRegistry: { refresh: () => Promise.reject(new Error("offline")) } });
  await new Promise((resolve) => setImmediate(resolve));
} finally {
  if (offline === undefined) delete process.env.PI_OFFLINE;
  else process.env.PI_OFFLINE = offline;
}
console.log("provider registration: background interactive refresh and awaited headless refresh passed");
