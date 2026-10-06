import strictAssert from "node:assert/strict";
import {
  type SearchResult,
  buildSearchRequest,
  formatSearchResult,
  parseSearchCommandArgs,
  parseSearchResponse,
  DEFAULT_SEARCH_MODEL,
} from "../src/search/index.js";

function fail(message: string): never {
  throw new Error(message);
}

function assert(condition: unknown, message: string): void {
  if (!condition) fail(`FAILED: ${message}`);
}

async function main() {
  // 1. parseSearchCommandArgs
  const simple = parseSearchCommandArgs("mimo 2.6 release date");
  assert(simple.query === "mimo 2.6 release date", "simple query parsed");
  assert(simple.thinking === undefined, "thinking undefined by default");
  assert(simple.urls === undefined, "urls undefined by default");

  const withFlags = parseSearchCommandArgs("--thinking --url https://example.com/doc1 --url https://example.com/doc2 deep dive on specs");
  assert(withFlags.query === "deep dive on specs", "query after flags");
  assert(withFlags.thinking === true, "thinking flag parsed");
  assert(Array.isArray(withFlags.urls) && withFlags.urls.length === 2, "urls parsed");
  assert(withFlags.urls?.[0] === "https://example.com/doc1", "first url");
  assert(withFlags.urls?.[1] === "https://example.com/doc2", "second url");

  // 2. buildSearchRequest
  const req = buildSearchRequest(
    {
      query: "compare models",
      instruction: "focus on benchmarks",
      urls: ["https://benchmark.org"],
      thinking: true,
    },
    DEFAULT_SEARCH_MODEL,
    "test-project-123",
  );

  assert(req.project === "test-project-123", "projectId set");
  assert(req.model === DEFAULT_SEARCH_MODEL, "model matches default");
  assert(req.requestType === "agent", "requestType set to agent");
  assert(req.userAgent === "antigravity", "userAgent set to antigravity");
  assert(typeof req.requestId === "string" && req.requestId.length > 0, "requestId envelope generated");

  const requestBody = req.request as any;
  assert(requestBody?.tools?.some((t: any) => t.googleSearch), "googleSearch tool present");
  assert(requestBody?.tools?.some((t: any) => t.urlContext), "urlContext tool present");
  assert(
    requestBody?.contents?.[0]?.parts?.[0]?.text?.includes("focus on benchmarks"),
    "lead agent directive in user prompt",
  );
  assert(
    requestBody?.systemInstruction?.parts?.[0]?.text?.includes("focus on benchmarks"),
    "lead agent directive in system instruction",
  );
  assert(
    requestBody?.generationConfig?.thinkingConfig?.thinkingBudget === 4096,
    "deep thinking budget applied",
  );

  // 3. parseSearchResponse
  const mockApiResponse = {
    response: {
      candidates: [
        {
          content: {
            role: "model",
            parts: [
              { thought: true, text: "Searching internal thoughts..." },
              { text: "MiMo-V2.6 was released on September 22, 2026." },
            ],
          },
          finishReason: "STOP",
          groundingMetadata: {
            webSearchQueries: ["mimo 2.6 release", "mimo specs"],
            groundingChunks: [
              {
                web: {
                  uri: "https://example.com/article",
                  title: "Example Article",
                },
              },
            ],
          },
        },
      ],
    },
  };

  const parsed = parseSearchResponse(mockApiResponse);
  assert(
    parsed.text === "MiMo-V2.6 was released on September 22, 2026.",
    "parsed text ignores thoughts",
  );
  assert(parsed.queries.length === 2 && parsed.queries[0] === "mimo 2.6 release", "queries extracted");
  assert(parsed.sources.length === 1 && parsed.sources[0]?.url === "https://example.com/article", "source url extracted");
  assert(parsed.sources[0]?.title === "Example Article", "source title extracted");

  // 4. formatSearchResult
  const markdown = formatSearchResult(parsed);
  assert(markdown.includes("MiMo-V2.6 was released on September 22, 2026."), "markdown contains text");
  assert(markdown.includes("### Sources"), "markdown contains English Sources heading");
  assert(markdown.includes("[Example Article](https://example.com/article)"), "markdown contains source link");
  assert(markdown.includes("*Search queries: `mimo 2.6 release`, `mimo specs`*"), "markdown contains English search queries label");

  // UTF-8 byte offsets, per-Part indices, skipped source chunks, and duplicate positions.
  const text = "日本語 clock. More.";
  const firstEnd = Buffer.byteLength("日本語 clock.");
  const grounded = parseSearchResponse({
    candidates: [{
      content: { parts: [
        { text: "First part." },
        { thought: true, text: "Hidden" },
        { text },
      ] },
      groundingMetadata: {
        groundingChunks: [
          { web: { uri: "https://example.com/a", title: "A" } },
          { other: {} },
          { web: { uri: "https://example.com/b", title: "B" } },
        ],
        groundingSupports: [
          { segment: { text: "First part.", endIndex: 11 }, groundingChunkIndices: [0] },
          { segment: { text: "日本語 clock.", endIndex: firstEnd, partIndex: 2 }, groundingChunkIndices: [0, 2, 99, -1, 0.5, "0"] },
          { segment: { text: "日本語 clock.", endIndex: firstEnd, partIndex: 2 }, groundingChunkIndices: [2, 0] },
          { segment: { text, endIndex: Buffer.byteLength(text), partIndex: 2 }, groundingChunkIndices: [2] },
          { segment: { text: "Hidden", endIndex: 6, partIndex: 1 }, groundingChunkIndices: [0] },
          { segment: { text: "Wrong", endIndex: 5, partIndex: 2 }, groundingChunkIndices: [0] },
          { segment: { text: "Too far", endIndex: 999, partIndex: 2 }, groundingChunkIndices: [0] },
          { segment: { text: "No offset" }, groundingChunkIndices: [0] },
          { segment: { text: "No web source", endIndex: 13 }, groundingChunkIndices: [1] },
          { segment: null, groundingChunkIndices: [0] },
        ],
      },
    }],
  });
  strictAssert.deepEqual(grounded.parts?.map(part => part.index), [0, 2]);
  strictAssert.deepEqual(grounded.sources.map(source => source.index), [0, 2]);
  strictAssert.deepEqual(grounded.supports?.[1]?.sourceIndices, [0, 2]);
  strictAssert.ok(!JSON.stringify(grounded).includes("Hidden"));
  const cited = formatSearchResult(grounded);
  strictAssert.ok(cited.startsWith("First part.[1]\n\n日本語 clock.[1][3] More.[3]"));
  strictAssert.ok(cited.includes("- [3] [B](https://example.com/b)"));
  strictAssert.ok(!cited.includes("Hidden"));
  strictAssert.ok(!cited.includes("�"));
  strictAssert.ok(formatSearchResult({ ...grounded, text: "Edited answer" }).startsWith("Edited answer"));

  // Preserve formatting and types for callers using the original public shape.
  const legacy: SearchResult = {
    text: "Legacy result", sources: [{ title: "Source", url: "https://example.com" }], queries: [],
  };
  strictAssert.equal(
    formatSearchResult(legacy),
    "Legacy result\n\n### Sources\n- [Source](https://example.com)",
  );
  strictAssert.equal(formatSearchResult({ text: "No sources", sources: [], queries: [] }), "No sources");

  console.log("search grounding: existing requests, byte-safe citations, and legacy shapes passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
