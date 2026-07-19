import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { ANTIGRAVITY_MODELS, PROVIDER_ID, PROVIDER_NAME } from "./models.js";
import {
  DEFAULT_ENDPOINT,
  getApiKey,
  lastAvailableModels,
  lastEndpoint,
  lastError,
  lastMatchedModelDebug,
  lastProjectId,
  lastResolvedRuntimeModel,
  lastStatus,
  loginAntigravity,
  redactSecrets,
  refreshAntigravityToken,
} from "./oauth.js";
import { ANTIGRAVITY_API, streamAntigravity } from "./stream.js";
import {
  fetchAccountUsage,
  formatModelsList,
  formatUsageSummary,
  resolveApiKeyFromContext,
} from "./usage.js";

async function withUsage(
  ctx: ExtensionCommandContext,
  fn: (usage: Awaited<ReturnType<typeof fetchAccountUsage>>) => string,
): Promise<void> {
  try {
    const apiKey = await resolveApiKeyFromContext(ctx);
    if (!apiKey) {
      const msg = "No Antigravity credentials. Run /login antigravity first.";
      if (ctx.hasUI) ctx.ui.notify(msg, "warning");
      else console.log(msg);
      return;
    }
    if (ctx.hasUI) ctx.ui.notify("Fetching Antigravity usage…", "info");
    const usage = await fetchAccountUsage(apiKey);
    const text = fn(usage);
    if (ctx.hasUI) ctx.ui.notify(text, "info");
    console.log(text);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (ctx.hasUI) ctx.ui.notify(`Antigravity usage failed: ${msg}`, "warning");
    else console.error(msg);
  }
}

export default function (pi: ExtensionAPI): void {
  pi.registerProvider(PROVIDER_ID, {
    name: PROVIDER_NAME,
    baseUrl: DEFAULT_ENDPOINT,
    api: ANTIGRAVITY_API,
    models: ANTIGRAVITY_MODELS,
    oauth: {
      name: PROVIDER_NAME,
      login: loginAntigravity,
      refreshToken: refreshAntigravityToken,
      getApiKey,
    },
    streamSimple: streamAntigravity,
  });

  pi.registerCommand("antigravity.usage", {
    description: "Show Antigravity shared quota pools (Gemini / Claude+GPT, 5h + weekly)",
    handler: async (_args, ctx) => {
      await withUsage(ctx, formatUsageSummary);
    },
  });

  pi.registerCommand("antigravity.models", {
    description: "List Antigravity runtime models + remaining pool fraction",
    handler: async (args, ctx) => {
      const all = /\ball\b/i.test(args || "");
      await withUsage(ctx, (usage) => formatModelsList(usage, { all }));
    },
  });

  pi.registerCommand("antigravity.doctor", {
    description: "Show sanitized Antigravity provider diagnostics",
    handler: async (_args, ctx) => {
      const lines = [
        `provider=${PROVIDER_ID}`,
        `lastResolvedRuntimeModel=${lastResolvedRuntimeModel || "none"}`,
        `availableModels=${lastAvailableModels || "none"}`,
        `matchedModel=${lastMatchedModelDebug || "none"}`,
        `lastEndpoint=${lastEndpoint || "none"}`,
        `lastStatus=${lastStatus ?? "none"}`,
        `lastProjectId=${lastProjectId || "none"}`,
        `lastError=${lastError ? redactSecrets(lastError) : "none"}`,
        "transport=native-streamSimple",
        "runtimeCli=not-used",
        "commands=/antigravity.usage /antigravity.models /antigravity.doctor",
      ];
      const text = lines.join("\n");
      if (ctx.hasUI) ctx.ui.notify(`Antigravity doctor\n${text}`, "info");
      console.log(text);
    },
  });
}
