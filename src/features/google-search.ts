/**
 * Optional model-facing search tool.
 * Disable this extension resource in `pi config` to keep the Antigravity provider
 * and `/antigravity.search` without registering `google_search`.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import { executeAntigravitySearch } from "../search/index.js";
import { extraToolExposure, isExtraToolEnabled, redactSecrets } from "../utils/index.js";

export default function (pi: ExtensionAPI): void {
  if (!isExtraToolEnabled("SEARCH")) return;
  pi.registerTool({
    ...extraToolExposure(),
    name: "google_search",
    label: "Google Search",
    description:
      "Search the web using Google Search via Antigravity Grounding. Returns a compact evidence brief with source citations. Use this whenever current, real-time information or web research is needed.",
    promptSnippet: "Real-time Google Search grounding via Antigravity",
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
      try {
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
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        throw new Error(redactSecrets(msg), { cause: error });
      }
    },
  });
}
