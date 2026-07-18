import { pathToFileURL } from "node:url";

const providers = [];
const commands = [];
const pi = {
  registerProvider(id, cfg) {
    providers.push({
      id,
      name: cfg.name,
      models: cfg.models?.length,
      hasOAuth: !!cfg.oauth,
      hasStream: typeof cfg.streamSimple === "function",
    });
  },
  registerCommand(name, cfg) {
    commands.push({ name, description: cfg.description });
  },
  unregisterProvider() {},
};

const mod = await import(
  pathToFileURL("/Users/rahularya/Projects/tools/pi-antigravity/src/index.ts").href
);
const ret = mod.default(pi);
console.log("providers=", JSON.stringify(providers, null, 2));
console.log("commands=", JSON.stringify(commands, null, 2));
console.log("deactivate=", typeof ret?.deactivate);
await ret?.deactivate?.();
console.log("extension_load=ok");
