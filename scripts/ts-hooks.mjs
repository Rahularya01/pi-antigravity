/**
 * Async loader fallback for Node versions without `module.registerHooks`.
 */
export async function resolve(specifier, context, nextResolve) {
  if (specifier.endsWith(".js")) {
    try {
      return await nextResolve(specifier, context);
    } catch (error) {
      try {
        return await nextResolve(`${specifier.slice(0, -3)}.ts`, context);
      } catch {
        throw error;
      }
    }
  }
  return nextResolve(specifier, context);
}
