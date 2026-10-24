import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  ANTIGRAVITY_IMAGE_API,
  ANTIGRAVITY_IMAGE_MODELS,
  generateAntigravityImages,
} from "./image/native.js";

// Namespace import: Oh My Pi rewrites this specifier onto bundled pi-ai, which
// does not export registerApiProvider. A static named import fails plugin load.
import * as piAiCompat from "@earendil-works/pi-ai/compat";
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
import { generateAntigravityImage, parseImageCommandArgs } from "./image/index.js";
import { executeAntigravitySearch, parseSearchCommandArgs } from "./search/index.js";
import {
  executeAntigravityWebFetch,
  discardSavedPage,
  formatWebFetchHeader,
  formatWebFetchResult,
  looksLikeHtml,
  parseFetchCommandArgs,
  savePage,
  savedPageNote,
  type SavedPage,
  withSavedCopy,
  validateFetchTarget,
} from "./web-fetch/index.js";
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

type CompatApiProviderRegistrar = (provider: {
  api: typeof ANTIGRAVITY_API;
  stream: typeof streamAntigravity;
  streamSimple: typeof streamAntigravity;
}) => void;

type CompatImagesProviderRegistrar = (provider: {
  api: typeof ANTIGRAVITY_IMAGE_API;
  generateImages: typeof generateAntigravityImages;
}) => void;

/**
 * Pi dispatches custom APIs through the compat registry. Oh My Pi does not
 * export `registerApiProvider` and registers the stream inside `registerProvider`.
 */
function registerCompatApiProvider(): void {
  const register = (piAiCompat as { registerApiProvider?: CompatApiProviderRegistrar })
    .registerApiProvider;
  if (typeof register === "function") {
    register({
      api: ANTIGRAVITY_API,
      stream: streamAntigravity,
      streamSimple: streamAntigravity,
    });
  }
  const registerImages = (
    piAiCompat as unknown as {
      registerImagesApiProvider?: CompatImagesProviderRegistrar;
    }
  ).registerImagesApiProvider;
  if (typeof registerImages === "function") {
    registerImages({
      api: ANTIGRAVITY_IMAGE_API,
      generateImages: generateAntigravityImages,
    });
  }
}

export default function (pi: ExtensionAPI): void {
  registerCompatApiProvider();

  // Print and RPC modes do not refresh catalogs before resolving --model. Refresh on
  // session start so a stale 1.2.x cache is replaced before the prompt, and so the next
  // headless process hydrates Gemini 4 from the persisted store (#93).
  pi.on("session_start", async (_event, ctx) => {
    if (process.env.PI_OFFLINE !== undefined) return;
    if (typeof ctx.modelRegistry?.refresh !== "function") return;
    try {
      await ctx.modelRegistry.refresh({ providers: [PROVIDER_ID] });
    } catch {
      // Last-known-good catalog stays in place. Forced refreshes still report via the command.
    }
  });

  const initialCatalog = getCurrentAntigravityCatalog();

  const providerConfig = {
    name: PROVIDER_NAME,
    baseUrl: DEFAULT_ENDPOINT,
    api: ANTIGRAVITY_API,
    models: [...initialCatalog.models, ...ANTIGRAVITY_IMAGE_MODELS],
    refreshModels: async (context: Parameters<typeof refreshAntigravityModels>[0]) => {
      const refreshed = await refreshAntigravityModels(context);
      return [...refreshed, ...ANTIGRAVITY_IMAGE_MODELS];
    },
    oauth: {
      name: PROVIDER_NAME,
      // Antigravity access is quota-backed by the Google account, not metered per token.
      // Pi uses this for the footer's (sub) marker and subscription-aware cost display.
      isSubscription: true,
      login: loginAndRemember,
      refreshToken: refreshAndRemember,
      getApiKey,
    },
    streamSimple: streamAntigravity,
    images: {
      [ANTIGRAVITY_IMAGE_API]: {
        generateImages: generateAntigravityImages,
      },
    },
  };

  // Pi 0.86 types are chat-only; newer Pi accepts mixed-operation models and images.
  pi.registerProvider(
    PROVIDER_ID,
    providerConfig as unknown as Parameters<typeof pi.registerProvider>[1],
  );

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
        ...(d.fetchTrace ? [`lastFetch=${d.fetchTrace}`] : []),
        `lastError=${d.error ? redactSecrets(d.error) : "none"}`,
        "transport=native-streamSimple",
        "runtimeCli=not-used",
        "commands=/antigravity.usage /antigravity.models /antigravity.accounts /antigravity.refresh /antigravity.doctor /antigravity.image /antigravity.search /antigravity.fetch",
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

  pi.registerCommand("antigravity.fetch", {
    description:
      "Read a public web page via the Antigravity crawler (usage: /antigravity.fetch [--raw] <url>)",
    handler: async (args, ctx) => {
      const parsed = parseFetchCommandArgs(args || "");
      if (!parsed.url) {
        emitCommandOutput(ctx, "Usage: /antigravity.fetch [--raw] <url>", "warning");
        return;
      }
      try {
        const url = validateFetchTarget(parsed.url);
        const apiKey = await resolveApiKeyFromContext(ctx);
        if (!apiKey) {
          emitCommandOutput(
            ctx,
            "No Antigravity credentials. Run /login antigravity first.",
            "warning",
          );
          return;
        }
        if (ctx.hasUI) ctx.ui.notify("Reading page via Antigravity…", "info");
        const result = await executeAntigravityWebFetch({
          apiKey,
          url,
          raw: parsed.raw,
        });
        const whole = result.content;
        let footer = "";
        let saved: SavedPage | undefined;
        if (formatWebFetchHeader(result).length + whole.length > (result.maxChars ?? 0)) {
          // Raw output is the crawled source itself; converted output keeps its provenance.
          saved = parsed.raw
            ? await savePage(whole, looksLikeHtml(whole) ? "html" : "txt")
            : await savePage(formatWebFetchHeader(result) + whole, "md");
          footer = savedPageNote(saved, whole.length, "Open it to read the rest.");
        }
        try {
          emitCommandOutput(ctx, formatWebFetchResult(result, footer));
        } catch (error) {
          if (saved) await discardSavedPage(saved);
          throw error;
        }
      } catch (caught) {
        const error = await withSavedCopy(caught);
        const msg = error instanceof Error ? error.message : String(error);
        const guidance = msg.replace(
          "Do not retry this URL with read_url_content. If permitted, use an available download tool or terminal to download it directly, then read the local file with a PDF reader.",
          "If you have permission, download the URL directly and open the local file with a PDF reader.",
        );
        emitCommandOutput(ctx, redactSecrets(guidance), "warning");
      }
    },
  });
}
