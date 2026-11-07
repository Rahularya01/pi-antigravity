import type { WebFetchResult } from "./web-fetch.js";
import { DEFAULT_WEB_FETCH_MAX_CHARS } from "./limits.js";
import { METADATA_LIMITS } from "./metadata.js";
import { cleanText, elideMiddle } from "../utils/text.js";
import { redactSecrets } from "../utils/security.js";

const sanitizeMetadataText = cleanText;

/** Format the page header, with bounded fields and redacted URLs. */
export function formatWebFetchHeader(result: WebFetchResult): string {
  const maxChars = result.maxChars ?? DEFAULT_WEB_FETCH_MAX_CHARS;
  // Provenance must fit inside the output budget, so a long URL cannot take it all.
  const headerBudget = Math.max(0, maxChars - Math.min(256, Math.floor(maxChars / 4)));
  const dropped = new Set<string>();
  const build = (urlLimit: number, titleLimit: number): string[] => {
    const text = (value: string | undefined, limit: number) =>
      sanitizeMetadataText(value === undefined ? undefined : redactSecrets(value), limit);
    const header = [
      "Page metadata (publisher claims):",
      `Title: ${text(result.title, titleLimit) ?? "Untitled page"}`,
    ];
    const add = (label: string, value: string | undefined) => {
      if (value === undefined || dropped.has(label)) return;
      header.push(`${label}: ${value}`);
    };
    add("Description", text(result.description, METADATA_LIMITS.description));
    add("Updated", text(result.updated, METADATA_LIMITS.updated));
    add("Author", text(result.author, METADATA_LIMITS.author));
    add("Published", text(result.published, METADATA_LIMITS.published));
    add("Language", text(result.language, METADATA_LIMITS.language));
    const url = (value: string) =>
      elideMiddle(sanitizeMetadataText(redactSecrets(value), 4_096) ?? "", urlLimit);
    if (result.representationUrl) header.push(`Representation: ${url(result.representationUrl)}`);
    if (!dropped.has("Retrieval") && result.attempts && result.attempts.length > 1) {
      const attempts = result.attempts.map(
        (attempt) =>
          `${attempt.stage ?? attempt.source}@${attempt.endpoint ? new URL(attempt.endpoint).hostname : "Google"}: ${text(attempt.outcome, 200) ?? ""}`,
      );
      header.push(`Retrieval: ${attempts.join(" → ")}`);
    }
    if (result.assessment && result.assessment !== "readable") {
      header.push(
        `Content assessment: ${result.assessment} (heuristic; source completeness does not establish article coverage).`,
      );
    }
    header.push("Retrieval provenance:");
    const requestedUrl = url(result.requestedUrl);
    const resolvedUrl = url(result.resolvedUrl);
    if (result.redirected || result.requestedUrl !== result.resolvedUrl)
      header.push(`Requested: ${requestedUrl}`);
    header.push(`Source: ${resolvedUrl} (${result.source === "live" ? "live" : "cache"})`);
    if (result.assessment === "empty" || result.assessment === "suspected-access-wall") {
      header.push(
        "Note: no reliable article was identified. Open the page in a browser or use another permitted source; do not keep retrying this URL.",
      );
    }
    if (result.assessment === "suspected-shell") {
      header.push(
        "Note: this appears to be a JavaScript-rendered page; this tool cannot render it. Open it in a browser.",
      );
    }
    if (result.partial === true) {
      header.push(
        result.content.trim()
          ? "Note: the crawler's copy ends mid-page, so some content may be missing."
          : "Note: the crawler's copy ends mid-page and holds no readable content.",
      );
    } else if (result.partial === null) {
      header.push(
        result.content.trim()
          ? "Note: the crawler's copy has no clear end marker, so completeness is unknown."
          : "Note: the crawler's copy has no clear end marker and holds no readable content.",
      );
    }
    for (const note of result.notes ?? []) add("Note", text(note, 300));
    return header;
  };
  let urlLimit = Math.max(64, Math.min(2_048, Math.floor(headerBudget / 4)));
  let titleLimit: number = METADATA_LIMITS.title;
  let header = build(urlLimit, titleLimit);
  // Optional metadata must not crowd provenance and the next captured range out.
  for (const label of ["Description", "Updated", "Author", "Published", "Language", "Retrieval"]) {
    if (header.join("\n").length + 7 <= headerBudget) break;
    dropped.add(label);
    header = build(urlLimit, titleLimit);
  }
  // A long URL must not crowd out the page content either.
  while (header.join("\n").length + 7 > headerBudget && urlLimit > 64) {
    urlLimit = Math.max(64, Math.floor(urlLimit / 2));
    header = build(urlLimit, titleLimit);
  }
  while (header.join("\n").length + 7 > headerBudget && titleLimit > 40) {
    titleLimit = Math.max(40, Math.floor(titleLimit / 2));
    header = build(urlLimit, titleLimit);
  }
  return `${header.join("\n")}\n\n---\n\n`;
}
