/**
 * Optional model-facing web fetch tool.
 * Disable this extension resource in `pi config` to keep the Antigravity provider
 * and `/antigravity.fetch` without registering `read_url_content`.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import { isExtraToolEnabled, redactSecrets } from "../utils/index.js";
import {
  executeAntigravityWebFetch,
  formatWebFetchHeader,
  formatWebFetchResult,
  resolveMaxChars,
  discardSavedPage,
  savePage,
  savedPageNote,
  type SavedPage,
  validateFetchTarget,
  withSavedCopy,
} from "../web-fetch/index.js";

export default function (pi: Pick<ExtensionAPI, "registerTool">): void {
  if (!isExtraToolEnabled("FETCH")) return;
  pi.registerTool({
    name: "read_url_content",
    label: "Read URL Content",
    description:
      "Read a public web page through Google's Antigravity crawler and return it as markdown. Use it for documentation, articles, changelogs, and standards pages when search snippets are not enough. The crawl runs on Google's side: no JavaScript execution, no cookies, and no pages behind a login — for those, ask the user to open the page in their browser.",
    promptSnippet: "Read a public web page as markdown via the Antigravity crawler",
    promptGuidelines: [
      "Use read_url_content when you have a specific URL whose contents you need, instead of guessing from a search result summary.",
      "One URL per call, and prefer the page that holds the answer over a site root or a category index.",
      "Long pages return their beginning and save the full page to a local file; read or search that file instead of fetching the URL again.",
      "It cannot log in, run JavaScript, or read local and private addresses, so do not use it for those.",
    ],
    parameters: Type.Object({
      url: Type.String({ description: "Public http(s) URL to fetch." }),
    }),
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      if (signal?.aborted) throw new Error("Web fetch aborted");
      const maxChars = resolveMaxChars();
      try {
        const url = validateFetchTarget(params.url);
        const apiKey = await ctx.modelRegistry.getApiKeyForProvider("antigravity");
        if (!apiKey) throw new Error("No Antigravity credentials. Run /login antigravity first.");
        if (signal?.aborted) throw new Error("Web fetch aborted");
        onUpdate?.({
          content: [{ type: "text", text: `Reading ${redactSecrets(url)}…` }],
          details: {},
        });
        const result = await executeAntigravityWebFetch({ apiKey, url, signal });
        if (signal?.aborted) throw new Error("Web fetch aborted");
        const attempts: Array<{
          source: string;
          outcome: string;
          url?: string;
          stage?: string;
          endpoint?: string;
        }> = [...(result.attempts ?? [])];
        const details = {
          source: result.source,
          bytes: result.bytes,
          truncated: false,
          partial: result.partial,
          assessment: result.assessment,
          representationUrl: result.representationUrl
            ? redactSecrets(result.representationUrl)
            : undefined,
          attempts,
          omittedAttempts: 0,
          fullOutputPath: undefined as string | undefined,
        };
        const detailsBudget = Math.floor(maxChars * 0.4);
        const size = () => JSON.stringify(details).length;
        while (size() > detailsBudget && details.attempts.length > 1) {
          details.attempts.shift();
          details.omittedAttempts += 1;
        }
        if (size() > detailsBudget && details.attempts.length === 1) {
          const last = details.attempts[0];
          details.attempts = [{ source: last.source, stage: last.stage, outcome: last.outcome }];
        }
        if (size() > detailsBudget) details.representationUrl = undefined;
        if (size() > detailsBudget && details.attempts.length) {
          details.attempts = [];
          details.omittedAttempts += 1;
        }
        const full = result.content;
        const captured = { ...result, maxChars: maxChars - size() };
        let footer = "";
        let saved: SavedPage | undefined;
        if (formatWebFetchHeader(captured).length + full.length > captured.maxChars) {
          // Pi's convention for long tool output: show the start, keep the whole on disk.
          saved = await savePage(formatWebFetchHeader(result) + full, "md");
          footer = savedPageNote(saved, full.length);
          if (saved.ok) details.fullOutputPath = saved.path;
          details.truncated = true;
          // The path is part of details too, so charge it before formatting.
          captured.maxChars = maxChars - size();
        }
        let text: string;
        try {
          if (signal?.aborted) throw new Error("Web fetch aborted");
          text = formatWebFetchResult(captured, footer);
        } catch (error) {
          // No answer will name the file, so leave none behind.
          if (saved) await discardSavedPage(saved);
          throw error;
        }
        return {
          content: [{ type: "text", text }],
          details,
        };
      } catch (caught) {
        const error = await withSavedCopy(caught);
        const msg = error instanceof Error ? error.message : String(error);
        // Error causes can retain request objects and response text; keep only a redacted message.
        const safe = redactSecrets(msg);
        // eslint-disable-next-line preserve-caught-error -- the raw cause can retain request/response bodies
        throw new Error(safe, { cause: new Error(safe) });
      }
    },
  });
}
