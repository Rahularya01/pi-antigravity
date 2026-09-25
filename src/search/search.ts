import {
  antigravityHeaders,
  endpointCandidates,
  jsonOrTextError,
  parseApiKey,
} from "../client/client.js";
import { AntigravityRequestType, AntigravityUserAgent, GeminiRole } from "../types/enums.js";
import { antigravityFetch } from "../utils/http.js";
import { safeError } from "../utils/security.js";
import { antigravityRequestEnvelope, isRecord } from "../utils/util.js";

/** Default search engine model: fast, natively supports groundings and reasoning. */
export const DEFAULT_SEARCH_MODEL = "gemini-3-flash";

/** Fallback runtime candidates if the primary flash model is undergoing rollout or capacity limits. */
export const SEARCH_MODEL_FALLBACKS = [
  DEFAULT_SEARCH_MODEL,
  "gemini-3.6-flash-low",
  "gemini-2.5-flash",
] as const;

export const SEARCH_SYSTEM_INSTRUCTION = `You are an expert deep-research investigator and technical analyst.
Your objective is to use Google Search Grounding to unearth rich, high-signal, multi-perspective facts.

Guidelines:
1. DO NOT settle for generic marketing summaries, public relations announcements, or shallow overviews.
2. Formulate multiple distinct, targeted search queries covering technical architecture, specific parameters, benchmark comparisons, developer issues, pitfalls, and community feedback.
3. Prioritize hard technical details: exact version numbers, hardware requirements, protocol constraints, benchmarks, error codes, and configuration snippets.
4. Structure your response into clean, logical Markdown sections citing direct sources.`;

export type SearchSource = {
  title: string;
  url: string;
};

export type SearchResult = {
  text: string;
  sources: SearchSource[];
  queries: string[];
};

export type ExecuteSearchOptions = {
  apiKey?: string;
  query: string;
  instruction?: string;
  urls?: string[];
  thinking?: boolean;
  signal?: AbortSignal;
};

export type SearchCommandArgs = {
  query: string;
  urls?: string[];
  thinking?: boolean;
};

/**
 * Parse arguments for the interactive `/antigravity.search` command.
 * Supports flags:
 *   --thinking: enable deep reasoning for search planning
 *   --url <url>: pass target URL for context analysis (can be repeated)
 *
 * @param args - Raw string of CLI arguments.
 * @returns Parsed command arguments containing query, optional URLs, and thinking flag.
 */
export function parseSearchCommandArgs(args: string): SearchCommandArgs {
  const tokens = args.trim().split(/\s+/).filter(Boolean);
  const out: SearchCommandArgs = { query: "" };
  const rest: string[] = [];

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === undefined) continue;
    const next = tokens[i + 1];

    if (token === "--thinking") {
      out.thinking = true;
      continue;
    }
    if (token === "--url" && next) {
      out.urls = out.urls ?? [];
      out.urls.push(next);
      i += 1;
      continue;
    }
    rest.push(token);
  }

  out.query = rest.join(" ");
  return out;
}

/**
 * Builds the Antigravity wire request payload for Gemini Google Search Grounding.
 * Includes the required `requestType` and `requestId` envelope fields.
 *
 * @param options - Options including search query, lead agent directives, target URLs, and thinking preference.
 * @param model - Target model identifier (e.g., `gemini-3-flash`).
 * @param projectId - Google Cloud Project ID.
 * @returns Serialized request object matching the Antigravity wire contract.
 */
export function buildSearchRequest(
  options: {
    query: string;
    instruction?: string;
    urls?: string[];
    thinking?: boolean;
  },
  model: string,
  projectId: string,
): Record<string, unknown> {
  let systemInstructionText = SEARCH_SYSTEM_INSTRUCTION;
  if (options.instruction?.trim()) {
    systemInstructionText += `\n\n[SPECIFIC DIRECTIVE FROM LEAD AGENT]:\n${options.instruction.trim()}\nYou MUST strictly follow this directive during search query formulation and synthesis.`;
  }

  let prompt = options.query.trim();
  if (options.instruction?.trim()) {
    prompt = `[Lead Agent Directive]: ${options.instruction.trim()}\n\nSearch Query: ${prompt}`;
  }
  if (options.urls && options.urls.length > 0) {
    prompt += `\n\nURLs to analyze in detail:\n${options.urls.join("\n")}`;
  }

  const tools: Array<Record<string, unknown>> = [{ googleSearch: {} }];
  if (options.urls && options.urls.length > 0) {
    tools.push({ urlContext: {} });
  }

  // Thinking budget: 4096 if explicitly requested, baseline 2048 to trigger multi-step search planning
  const thinkingBudget = options.thinking ? 4096 : 2048;
  const envelope = antigravityRequestEnvelope(model, false);

  return {
    project: projectId,
    model,
    request: {
      systemInstruction: {
        role: GeminiRole.User,
        parts: [{ text: systemInstructionText }],
      },
      contents: [
        {
          role: GeminiRole.User,
          parts: [{ text: prompt }],
        },
      ],
      tools,
      generationConfig: {
        thinkingConfig: {
          thinkingBudget,
          includeThoughts: false,
        },
      },
    },
    requestType: AntigravityRequestType.Agent,
    userAgent: AntigravityUserAgent.Antigravity,
    requestId: envelope.requestId,
  };
}

/**
 * Parse candidate text and Grounding metadata from Antigravity API response.
 *
 * @param data - Raw JSON response from Antigravity generateContent API.
 * @returns Structured SearchResult with synthesized text, web queries, and cited source URLs.
 */
export function parseSearchResponse(data: unknown): SearchResult {
  const result: SearchResult = { text: "", sources: [], queries: [] };
  if (!isRecord(data)) return result;

  const responseObj = isRecord(data.response) ? data.response : data;
  const candidates = Array.isArray(responseObj.candidates) ? responseObj.candidates : [];
  const candidate = candidates[0];

  if (!isRecord(candidate)) {
    const errorObj = isRecord(data.error) ? data.error : isRecord(responseObj.error) ? responseObj.error : undefined;
    const msg = typeof errorObj?.message === "string" ? errorObj.message : "No candidate returned from Antigravity Search";
    result.text = `Error: ${msg}`;
    return result;
  }

  // Extract synthesized text (ignoring thinking parts)
  const content = isRecord(candidate.content) ? candidate.content : undefined;
  if (Array.isArray(content?.parts)) {
    result.text = content.parts
      .filter((p) => isRecord(p) && !p.thought && typeof p.text === "string")
      .map((p) => (p as { text: string }).text)
      .filter(Boolean)
      .join("\n\n");
  }

  // Extract grounding citations & executed queries
  const grounding = isRecord(candidate.groundingMetadata) ? candidate.groundingMetadata : undefined;
  if (grounding) {
    if (Array.isArray(grounding.webSearchQueries)) {
      result.queries = grounding.webSearchQueries.filter((q): q is string => typeof q === "string");
    }
    if (Array.isArray(grounding.groundingChunks)) {
      for (const chunk of grounding.groundingChunks) {
        if (!isRecord(chunk)) continue;
        const web = isRecord(chunk.web) ? chunk.web : undefined;
        if (typeof web?.uri === "string") {
          result.sources.push({
            title: typeof web.title === "string" && web.title.trim() ? web.title.trim() : web.uri,
            url: web.uri,
          });
        }
      }
    }
  }

  return result;
}

/**
 * Formats structured SearchResult into clean Markdown for agent consumption.
 *
 * @param res - Structured search result containing text, sources, and executed queries.
 * @returns Formatted markdown string.
 */
export function formatSearchResult(res: SearchResult): string {
  const sections: string[] = [];

  if (res.text) {
    sections.push(res.text);
  }

  if (res.sources.length > 0) {
    const list = res.sources.map((s) => `- [${s.title}](${s.url})`).join("\n");
    sections.push(`### Sources\n${list}`);
  }

  if (res.queries.length > 0) {
    const queries = res.queries.map((q) => `\`${q}\``).join(", ");
    sections.push(`*Search queries: ${queries}*`);
  }

  return sections.join("\n\n");
}

/**
 * Execute real-time Google Search grounding via Antigravity backend with automatic fallback.
 *
 * @param options - Execution options containing query, API credentials, and optional directives.
 * @returns Markdown formatted search result with synthesis, citations, and search queries.
 */
export async function executeAntigravitySearch(options: ExecuteSearchOptions): Promise<string> {
  const query = options.query.trim();
  if (!query) throw new Error("Search query is required.");

  const creds = parseApiKey(options.apiKey);
  const headers = antigravityHeaders(creds.token);

  let lastError = "no endpoint available";

  for (const model of SEARCH_MODEL_FALLBACKS) {
    const body = JSON.stringify(buildSearchRequest(options, model, creds.projectId));

    for (const endpoint of endpointCandidates()) {
      if (options.signal?.aborted) throw new Error("Search request was aborted");

      try {
        const response = await antigravityFetch(
          `${endpoint}/v1internal:generateContent`,
          {
            method: "POST",
            headers,
            body,
            signal: options.signal,
          },
        );

        if (!response.ok) {
          lastError = jsonOrTextError(await response.text()).slice(0, 400);
          if (response.status === 404 || [429, 500, 502, 503, 504].includes(response.status)) {
            continue; // Retry next endpoint for transient failures or missing model endpoints
          }
          // Fail fast on non-retryable client errors (e.g. 400 Bad Request, 401 Unauthorized, 403 Forbidden)
          throw Object.assign(new Error(lastError), { fatal: true });
        }

        const data: unknown = await response.json();
        const cand = isRecord(data) && isRecord(data.response) && Array.isArray(data.response.candidates)
          ? data.response.candidates[0]
          : isRecord(data) && Array.isArray(data.candidates)
          ? data.candidates[0]
          : undefined;

        const candidateText =
          isRecord(cand) && isRecord(cand.content) && Array.isArray(cand.content.parts)
            ? (cand.content.parts[0] as { text?: string })?.text
            : undefined;

        // Skip responses indicating deprecated model and move to next fallback model
        if (candidateText && candidateText.includes("is no longer available. Please switch")) {
          lastError = `Model ${model} deprecated: ${candidateText.slice(0, 100)}`;
          break;
        }

        const parsed = parseSearchResponse(data);
        return formatSearchResult(parsed);
      } catch (error) {
        if (options.signal?.aborted) throw error;
        if (error instanceof Error && (error as { fatal?: boolean }).fatal) throw error;
        lastError = safeError(error).slice(0, 400);
      }
    }
  }

  throw new Error(`Antigravity Google Search failed: ${lastError}`);
}
