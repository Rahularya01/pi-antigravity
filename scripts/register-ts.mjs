import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";

function resolveJsToTs(specifier, context, nextResolve) {
  if (specifier.endsWith(".js") && context.parentURL) {
    try {
      const asTs = new URL(`${specifier.slice(0, -3)}.ts`, context.parentURL);
      if (existsSync(fileURLToPath(asTs))) {
        return nextResolve(`${specifier.slice(0, -3)}.ts`, context);
      }
    } catch {
      // Fall through to default resolution.
    }
  }
  return nextResolve(specifier, context);
}

registerHooks({ resolve: resolveJsToTs });
