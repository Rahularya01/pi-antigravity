import strictAssert from "node:assert/strict";
import {
  isPrivateAddress,
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

/** Cover citation placement, source labels, and the private-address guard. */
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

  // 7. Page-title fetching must never be pointed at an internal address. Search results are
  //    attacker-influenced, and whatever comes back is shown to the model.
  for (const address of [
    "127.0.0.1",
    "0.0.0.0",
    "10.1.2.3",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "169.254.169.254",
    "100.64.0.1",
    "224.0.0.1",
    "::1",
    "::",
    "fd00::1",
    "fe80::1",
    "::ffff:127.0.0.1",
  ]) {
    strictAssert.equal(isPrivateAddress(address), true, `${address} must be rejected`);
  }
  // The URL API keeps the brackets on an IPv6 literal, so they have to come off first.
  strictAssert.equal(isPrivateAddress("[::1]"), true, "a bracketed IPv6 literal must be rejected");
  strictAssert.equal(isPrivateAddress("[2606:4700::1111]"), false);
  for (const address of ["8.8.8.8", "1.1.1.1", "172.32.0.1", "11.0.0.1", "2606:4700::1111"]) {
    strictAssert.equal(isPrivateAddress(address), false, `${address} is public`);
  }
  strictAssert.equal(isPrivateAddress("example.com"), false, "a name is not an address");

  console.log(
    "search citations: drifted offsets, headings, tables, fenced code, labels, private-address guard passed",
  );
}

main();
