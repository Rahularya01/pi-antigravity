import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { StringEnum, Type } from "@earendil-works/pi-ai";
import { registerApiProvider } from "@earendil-works/pi-ai/compat";
import {
  activateAccount,
  getApiKey,
  listAccounts,
  loginAntigravity,
  rememberAccount,
  refreshAntigravityToken,
  removeAccount,
  updateRememberedAccount,
} from "./auth/index.js";
import { DEFAULT_ENDPOINT } from "./client/index.js";
import { getLastDiagnostics, runWithDiagnostics } from "./diagnostics/index.js";
import {
  DEFAULT_IMAGE_MODEL,
  generateAntigravityImage,
  IMAGE_ASPECT_RATIOS,
  parseImageCommandArgs,
} from "./image/index.js";
import {
  executeAntigravitySearch,
  parseSearchCommandArgs,
} from "./search/index.js";
import {
  applyAntigravityCatalog,
  discoverAntigravityModels,
  getCurrentAntigravityCatalog,
  PROVIDER_ID,
  PROVIDER_NAME,
  refreshAntigravityModels,
  resolvedCatalog,
} from "./models/index.js";
import { ANTIGRAVITY_API, streamAntigravity } from "./stream/index.js";
import {
  fetchAccountUsage,
  formatModelsList,
  formatUsageSummary,
  resolveApiKeyFromContext,
} from "./usage/index.js";
import { redactSecrets, maskEmail } from "./utils/index.js";

/**
 * Pi's interactive `notify` writes into the chat transcript. `console.log` in that
 * mode prints to the raw terminal and paints over the TUI. Use one channel only.
 */
function emitCommandOutput(
  ctx: ExtensionCommandContext,
  text: string,
  type: "info" | "warning" | "error" = "info",
): void {
  if (ctx.hasUI) {
    ctx.ui.notify(text, type);
    return;
  }
  if (type === "warning" || type === "error") console.error(text);
  else console.log(text);
}

async function loginAndRemember(
  callbacks: Parameters<typeof loginAntigravity>[0],
): ReturnType<typeof loginAntigravity> {
  const credentials = await loginAntigravity(callbacks);
  rememberAccount(credentials);
  return credentials;
}

async function refreshAndRemember(
  credentials: Parameters<typeof refreshAntigravityToken>[0],
): ReturnType<typeof refreshAntigravityToken> {
  const refreshed = await refreshAntigravityToken(credentials);
  updateRememberedAccount(credentials, refreshed);
  return refreshed;
}

async function withUsage(
  ctx: ExtensionCommandContext,
  fn: (usage: Awaited<ReturnType<typeof fetchAccountUsage>>) => string,
): Promise<void> {
  try {
    const apiKey = await resolveApiKeyFromContext(ctx);
    if (!apiKey) {
      emitCommandOutput(
        ctx,
        "No Antigravity credentials. Run /login antigravity first.",
        "warning",
      );
      return;
    }
    if (ctx.hasUI) ctx.ui.notify("Fetching Antigravity usage…", "info");
    const usage = await runWithDiagnostics(() => fetchAccountUsage(apiKey));
    emitCommandOutput(ctx, fn(usage));
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    emitCommandOutput(ctx, `Antigravity usage failed: ${msg}`, "warning");
  }
}

export default function (pi: ExtensionAPI): void {
  registerApiProvider({
    api: ANTIGRAVITY_API,
    stream: streamAntigravity,
    streamSimple: streamAntigravity,
  });

  const initialCatalog = getCurrentAntigravityCatalog();

  pi.registerProvider(PROVIDER_ID, {
    name: PROVIDER_NAME,
    baseUrl: DEFAULT_ENDPOINT,
    api: ANTIGRAVITY_API,
    models: initialCatalog.models,
    refreshModels: refreshAntigravityModels,
    oauth: {
      name: PROVIDER_NAME,
      login: loginAndRemember,
      refreshToken: refreshAndRemember,
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

  pi.registerCommand("antigravity.accounts", {
    description: "List, switch, or remove linked Antigravity Google accounts",
    handler: async (args, ctx) => {
      const command = args.trim();
      try {
        if (command.startsWith("switch ")) {
          const account = await activateAccount(command.slice("switch ".length));
          emitCommandOutput(
            ctx,
            `Active Antigravity account: ${account.email || account.accountId}`,
          );
          return;
        }
        if (command.startsWith("remove ")) {
          const remaining = await removeAccount(command.slice("remove ".length));
          const next = remaining
            ? ` Active account is now ${remaining.email || remaining.accountId}.`
            : "";
          emitCommandOutput(ctx, `Antigravity account removed.${next}`);
          return;
        }
        const accounts = listAccounts();
        if (accounts.length === 0) {
          emitCommandOutput(
            ctx,
            "No linked Antigravity accounts. Run /login antigravity to add one.",
            "warning",
          );
          return;
        }
        const lines = accounts.map(
          (account, index) =>
            `${account.active ? "* " : "  "}${index + 1}. ${account.email || account.accountId}`,
        );
        emitCommandOutput(
          ctx,
          `${lines.join("\n")}\nUse /antigravity.accounts switch <index|email> or /antigravity.accounts remove <index|email>.`,
        );
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        emitCommandOutput(ctx, msg, "error");
      }
    },
  });

  pi.registerCommand("antigravity.refresh", {
    description: "Force refresh Antigravity dynamic model catalog",
    handler: async (_args, ctx) => {
      const apiKey = await resolveApiKeyFromContext(ctx);
      if (!apiKey) {
        emitCommandOutput(
          ctx,
          "No Antigravity credentials. Run /login antigravity first.",
          "warning",
        );
        return;
      }
      if (ctx.hasUI) ctx.ui.notify("Refreshing Antigravity models…", "info");
      try {
        if (typeof ctx.modelRegistry?.refresh === "function") {
          const result = await ctx.modelRegistry.refresh({
            force: true,
            providers: [PROVIDER_ID],
          });
          if (result?.errors?.has(PROVIDER_ID)) {
            throw result.errors.get(PROVIDER_ID)!;
          }
        } else {
          const discovered = await discoverAntigravityModels(apiKey);
          const next = resolvedCatalog(discovered, getCurrentAntigravityCatalog());
          if (discovered.models.length > 0) {
            applyAntigravityCatalog(next);
          }
        }
        const catalog = getCurrentAntigravityCatalog();
        const count = catalog.models.length;
        const sample = catalog.models
          .slice(0, 4)
          .map((m) => m.name || m.id)
          .join(", ");
        emitCommandOutput(
          ctx,
          `Antigravity models refreshed (${count} available: ${sample}${count > 4 ? ", …" : ""})`,
          "info",
        );
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        emitCommandOutput(ctx, `Antigravity model refresh failed: ${redactSecrets(msg)}`, "error");
      }
    },
  });

  pi.registerCommand("antigravity.doctor", {
    description: "Show sanitized Antigravity provider diagnostics",
    handler: async (_args, ctx) => {
      const d = getLastDiagnostics();
      const accounts = listAccounts();
      const active = accounts.find((account) => account.active);
      const activeLabel = active
        ? maskEmail(active.email) ||
          (active.accountId.includes("@") ? maskEmail(active.accountId) : active.accountId)
        : "none";
      const lines = [
        `provider=${PROVIDER_ID}`,
        `lastResolvedRuntimeModel=${d.resolvedRuntimeModel || "none"}`,
        `availableModels=${d.availableModels || "none"}`,
        `matchedModel=${d.matchedModelDebug || "none"}`,
        `lastEndpoint=${d.endpoint || "none"}`,
        `lastStatus=${d.status ?? "none"}`,
        `lastProjectId=${d.projectId || "none"}`,
        `linkedAccounts=${accounts.length || "none"}`,
        `activeAccount=${activeLabel || "none"}`,
        ...(d.latencyMs !== undefined ? [`lastLatencyMs=${d.latencyMs}`] : []),
        `toolSchemaWarnings=${d.toolSchemaWarnings || "none"}`,
        `lastError=${d.error ? redactSecrets(d.error) : "none"}`,
        "transport=native-streamSimple",
        "runtimeCli=not-used",
        "commands=/antigravity.usage /antigravity.models /antigravity.accounts /antigravity.refresh /antigravity.doctor /antigravity.image /antigravity.search",
      ];
      emitCommandOutput(ctx, `Antigravity doctor\n${lines.join("\n")}`);
    },
  });

  pi.registerCommand("antigravity.image", {
    description:
      "Generate an image via Antigravity (usage: /antigravity.image [--ratio 16:9] <prompt>)",
    handler: async (args, ctx) => {
      const parsed = parseImageCommandArgs(args || "");
      if (!parsed.prompt) {
        emitCommandOutput(
          ctx,
          "Usage: /antigravity.image [--ratio 16:9] [--model gemini-3-pro-image] [--path file.png] <prompt>",
          "warning",
        );
        return;
      }
      try {
        const apiKey = await resolveApiKeyFromContext(ctx);
        if (!apiKey) {
          emitCommandOutput(
            ctx,
            "No Antigravity credentials. Run /login antigravity first.",
            "warning",
          );
          return;
        }
        if (ctx.hasUI) ctx.ui.notify("Generating Antigravity image…", "info");
        const result = await generateAntigravityImage({
          apiKey,
          cwd: ctx.cwd,
          prompt: parsed.prompt,
          aspectRatio: parsed.aspectRatio,
          model: parsed.model,
          path: parsed.path,
        });
        emitCommandOutput(ctx, `Saved image to ${result.savedPaths.join(", ")}`);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        emitCommandOutput(ctx, `Antigravity image failed: ${redactSecrets(msg)}`, "warning");
      }
    },
  });

  pi.registerCommand("antigravity.search", {
    description:
      "Search the web via Antigravity Grounding (usage: /antigravity.search [--thinking] [--url <url>] <query>)",
    handler: async (args, ctx) => {
      const parsed = parseSearchCommandArgs(args || "");
      if (!parsed.query) {
        emitCommandOutput(
          ctx,
          "Usage: /antigravity.search [--thinking] [--url <url>] <query>",
          "warning",
        );
        return;
      }
      try {
        const apiKey = await resolveApiKeyFromContext(ctx);
        if (!apiKey) {
          emitCommandOutput(
            ctx,
            "No Antigravity credentials. Run /login antigravity first.",
            "warning",
          );
          return;
        }
        if (ctx.hasUI) ctx.ui.notify("Searching Google via Antigravity Grounding…", "info");
        const result = await executeAntigravitySearch({
          apiKey,
          query: parsed.query,
          urls: parsed.urls,
          thinking: parsed.thinking,
        });
        emitCommandOutput(ctx, result);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        emitCommandOutput(ctx, `Antigravity search failed: ${redactSecrets(msg)}`, "warning");
      }
    },
  });

  pi.registerTool({
    name: "generate_image",
    label: "Generate image",
    description:
      "Generate an image via Antigravity using the signed-in Google account. Saves under .pi/generated-images/ unless path is set.",
    promptSnippet: "Generate images via Antigravity OAuth (Gemini image models)",
    promptGuidelines: [
      "Use generate_image when the user asks to create, draw, or generate an image.",
    ],
    parameters: Type.Object({
      prompt: Type.String({ description: "Image description." }),
      aspectRatio: Type.Optional(StringEnum(IMAGE_ASPECT_RATIOS)),
      model: Type.Optional(
        Type.String({
          description: `Image model id. Default: ${DEFAULT_IMAGE_MODEL}.`,
        }),
      ),
      path: Type.Optional(
        Type.String({
          description: "Project-relative file or directory to save the image.",
        }),
      ),
    }),
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const apiKey = await ctx.modelRegistry.getApiKeyForProvider("antigravity");
      if (!apiKey) {
        throw new Error("No Antigravity credentials. Run /login antigravity first.");
      }
      onUpdate?.({ content: [{ type: "text", text: "Generating image…" }], details: {} });
      const result = await generateAntigravityImage({
        apiKey,
        cwd: ctx.cwd,
        prompt: params.prompt,
        aspectRatio: params.aspectRatio,
        model: params.model,
        path: params.path,
        signal,
      });
      const notes = result.text.join(" ").trim();
      return {
        content: [
          {
            type: "text" as const,
            text: `Saved image to ${result.savedPaths.join(", ")}${notes ? `. ${notes}` : ""}`,
          },
          ...result.images.map((image) => ({
            type: "image" as const,
            data: image.data,
            mimeType: image.mimeType,
          })),
        ],
        details: { model: result.model, savedPaths: result.savedPaths },
      };
    },
  });

  pi.registerTool({
    name: "google_search",
    label: "Google Search",
    description:
      "Search the web using Google Search via Antigravity Grounding powered by Gemini 3 Flash. Returns real-time web results with multi-angle deep search and source citations. Use this whenever current, real-time information or web research is needed.",
    promptSnippet: "Real-time Google Search grounding via Antigravity (Gemini 3 Flash)",
    promptGuidelines: [
      "Use google_search when you need real-time, up-to-date web information, latest news, documentation, or fact checking.",
      "Pass specific URLs into the urls array if you want the search engine to fetch and analyze specific pages.",
      "Set instruction to provide special research directives from the lead agent (e.g. focus on issues, compare benchmarks, restrict time range).",
    ],
    parameters: Type.Object({
      query: Type.String({ description: "Search query or question." }),
      instruction: Type.Optional(
        Type.String({
          description:
            "Specific directive or focus from the lead agent (e.g., '重点关注英文社区近七天的讨论', 'focus on GitHub issues and benchmarks', 'ignore marketing announcements').",
        }),
      ),
      urls: Type.Optional(
        Type.Array(Type.String(), {
          description: "Optional specific URLs to fetch and analyze alongside the search.",
        }),
      ),
      thinking: Type.Optional(
        Type.Boolean({
          description: "Enable deeper thinking for complex analysis (default: false).",
        }),
      ),
    }),
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const apiKey = await ctx.modelRegistry.getApiKeyForProvider("antigravity");
      if (!apiKey) {
        throw new Error("No Antigravity credentials. Run /login antigravity first.");
      }
      onUpdate?.({
        content: [{ type: "text", text: `Searching Google for: "${params.query}"…` }],
        details: {},
      });
      const result = await executeAntigravitySearch({
        apiKey,
        query: params.query,
        instruction: params.instruction,
        urls: params.urls,
        thinking: params.thinking,
        signal,
      });
      return {
        content: [{ type: "text", text: result }],
        details: {},
      };
    },
  });
}
