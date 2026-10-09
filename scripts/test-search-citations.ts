import strictAssert from "node:assert/strict";
import {
  type SearchResult,
  type SearchSource,
  formatSearchResult,
  parseSearchResponse,
  sourceLabel,
} from "../src/search/index.js";

/**
 * A SearchResult built the way parseSearchResponse builds one, so the citation
 * layout can be exercised without going through the HTTP layer.
 */
function build(text: string, sources: SearchSource[], supports: SearchResult["supports"]): SearchResult {
  return { text, sources, queries: [], parts: [{ index: 0, text }], supports };
}

/** Byte length, because grounding offsets are UTF-8 bytes rather than character indices. */
const bytes = (value: string): number => Buffer.byteLength(value, "utf8");

function main(): void {
  // 1. A support whose reported offsets do not match its own text is relocated by
  //    searching the part, instead of being dropped along with its provenance.
  const drifted = formatSearchResult(
    build("Alpha claim. Beta claim.", [{ index: 0, title: "Source", url: "https://example.com/doc" }], [
      { text: "Beta claim.", startIndex: 9_999, endIndex: 9_999, sourceIndices: [0] },
    ]),
  );
  strictAssert.ok(
    drifted.includes("Beta claim. [1] [Source](https://example.com/doc)"),
    `drifted offsets should still cite: ${drifted}`,
  );

  // The number carried by the first mention must match the entry in the sources list, so a
  // later bare `[n]` is always resolvable.
  const firstMention = drifted.match(/\[(\d+)\] \[Source\]/)?.[1];
  const listed = drifted.match(/^- \[(\d+)\] \[Source\]/m)?.[1];
  strictAssert.equal(firstMention, listed, `mention number must match the list: ${drifted}`);

  // 2. Markdown headings never take a marker: Google attaches supports to them too,
  //    which would otherwise emit `### Heading[1]` and consume a source's first mention.
  const heading = formatSearchResult(
    build(
      "### 1. Single-Writer Rule\nSQLite serializes writes. [0]",
      [{ index: 0, title: "Source", url: "https://example.com/doc" }],
      [
        { text: "1. Single-Writer Rule", startIndex: 4, endIndex: bytes("### 1. Single-Writer Rule"), sourceIndices: [0] },
      ],
    ),
  );
  strictAssert.ok(!/^#{1,6}.*\[/.test(heading.split("\n")[0] ?? ""), `heading must stay clean: ${heading}`);

  // 3. A table row takes its marker inside the final pipe, so the pipe count per row
  //    stays constant and the table keeps its column count.
  const tableRows = [
    "| Name | Note |",
    "| --- | --- |",
    "| alpha | short |",
  ];
  const tableText = tableRows.join("\n");
  const table = formatSearchResult(
    build(tableText, [{ index: 0, title: "Source", url: "https://example.com/doc" }], [
      { text: "| alpha | short |", startIndex: bytes("| Name | Note |\n| --- | --- |\n"), endIndex: bytes(tableText), sourceIndices: [0] },
    ]),
  );
  const dataRow = table.split("\n").find((line) => line.startsWith("| alpha")) ?? "";
  strictAssert.equal(
    dataRow.split("|").length,
    "| alpha | short |".split("|").length,
    `table row must keep its column count: ${dataRow}`,
  );
  strictAssert.ok(
    dataRow.includes("[1] [Source](https://example.com/doc)"),
    `table row should still cite: ${dataRow}`,
  );
  const headerRow = table.split("\n")[0] ?? "";
  strictAssert.ok(!headerRow.includes("["), `table header must stay clean: ${headerRow}`);

  // 4. Fenced code is data, not a claim, so nothing is inserted inside it.
  const fenced = formatSearchResult(
    build(
      "Run this:\n```sql\nPRAGMA busy_timeout = 5000;\n```\nThen retry. [0]",
      [{ index: 0, title: "Source", url: "https://example.com/doc" }],
      [
        { text: "PRAGMA busy_timeout = 5000;", startIndex: bytes("Run this:\n```sql\n"), endIndex: bytes("Run this:\n```sql\nPRAGMA busy_timeout = 5000;"), sourceIndices: [0] },
      ],
    ),
  );
  strictAssert.ok(
    fenced.includes("PRAGMA busy_timeout = 5000;\n```"),
    `code block must stay untouched: ${fenced}`,
  );

  // 5. Labels: a real page title wins, a brand-only title is rejected as useless for
  //    telling two pages apart, and the opaque redirect path is never used.
  const redirect = "https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQabc";
  strictAssert.equal(
    sourceLabel({ title: "github.com", url: redirect, pageTitle: "argoproj/argo-cd v3.5.4" }),
    "argoproj/argo-cd v3.5.4",
  );
  strictAssert.equal(
    sourceLabel({ title: "reddit.com", url: "https://www.reddit.com/r/golang/comments/1exk981/x" }),
    "reddit.com/r/golang/comments/1exk981/x",
  );
  strictAssert.equal(
    sourceLabel({ title: "github.com", url: redirect }),
    "github.com",
    "a redirect URL with no other information must not leak its opaque path",
  );
  strictAssert.equal(
    sourceLabel({ title: "medium.com", url: redirect, resolvedUrl: "https://medium.com/topic/item" }),
    "medium.com/topic/item",
  );

  // 6. Sources are deduplicated by URL rather than by host, so several pages from one
  //    host stay distinct entries.
  const duplicates = parseSearchResponse({
    candidates: [
      {
        content: { parts: [{ text: "Claim." }] },
        groundingMetadata: {
          groundingChunks: [
            { web: { uri: "https://example.com/one", title: "example.com" } },
            { web: { uri: "https://example.com/two", title: "example.com" } },
            { web: { uri: "https://example.com/one", title: "example.com" } },
          ],
        },
      },
    ],
  });
  strictAssert.equal(duplicates.sources.length, 3, "parseSearchResponse keeps one entry per chunk");

  console.log("search citations: drifted offsets, headings, tables, fenced code, labels passed");
}

main();
