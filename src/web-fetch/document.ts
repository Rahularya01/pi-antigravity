import { createDocument } from "@mixmark-io/domino";
import { repairText } from "../utils/text.js";

/** Work limits apply before the recursive DOM parser or converter sees a document. */
export const MAX_DOCUMENT_CHARS = 2_000_000;
export const MAX_DOCUMENT_DEPTH = 128;
export const MAX_DOCUMENT_NODES = 50_000;
const VOID = new Set(
  "area base br col embed hr img input link meta param source track wbr".split(" "),
);
const TOKENS =
  /<!--[\s\S]*?(?:-->|$)|<(script|style|textarea|title|noscript|xmp|iframe|noembed|noframes|plaintext)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)|<\/?([a-z][\w:-]*)\b(?:[^"'<>]|"[^"]*"|'[^']*')*>/gi;

/** The page is beyond what the converter will take on; the source itself is fine. */
export class DocumentLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DocumentLimitError";
  }
}

/**
 * The parser accepts tag names such as `a<a` that the DOM later refuses to clone, which
 * would fail the whole read at conversion. Replace each with a span holding its children.
 */
function neutralizeInvalidElements(document: Document): void {
  for (const element of Array.from(document.querySelectorAll("*"))) {
    try {
      document.createElement(element.localName);
      continue;
    } catch {
      // Invalid name: replace below.
    }
    const span = document.createElement("span");
    while (element.firstChild) span.appendChild(element.firstChild);
    element.parentNode?.replaceChild(span, element);
  }
}

/** Reject bounded-but-pathological input with an actionable page-level error. */
export function parseDocument(source: string): Document {
  if (source.length > MAX_DOCUMENT_CHARS)
    throw new DocumentLimitError(
      "The page is too large to convert safely. Open it in a browser or request a smaller page.",
    );
  const stack: string[] = [];
  let nodes = 0;
  for (const match of source.matchAll(TOKENS)) {
    if (++nodes > MAX_DOCUMENT_NODES)
      throw new DocumentLimitError(
        "The page has too many elements to convert safely. Open it in a browser.",
      );
    const tag = match[2]?.toLowerCase();
    if (!tag || VOID.has(tag)) continue;
    if (match[0].startsWith("</")) {
      const index = stack.lastIndexOf(tag);
      if (index >= 0) stack.length = index;
    } else {
      // Optional end tags close a sibling and its descendants, not merely the
      // stack's top. Respect list/table boundaries so nested containers remain nested.
      const closeSibling = (names: string[], boundaries: string[]) => {
        const sibling = Math.max(...names.map((name) => stack.lastIndexOf(name)));
        const boundary = Math.max(-1, ...boundaries.map((name) => stack.lastIndexOf(name)));
        if (sibling > boundary) stack.length = sibling;
      };
      if (/^(?:p|div|section|article|main|h[1-6]|ul|ol|table|blockquote)$/.test(tag))
        closeSibling(["p"], []);
      if (tag === "li") closeSibling(["li"], ["ul", "ol"]);
      if (tag === "dt" || tag === "dd") closeSibling(["dt", "dd"], ["dl"]);
      if (tag === "tr") closeSibling(["tr"], ["table"]);
      if (tag === "td" || tag === "th") closeSibling(["td", "th"], ["tr"]);
      if (tag === "option") closeSibling(["option"], ["select", "datalist"]);
      stack.push(tag);
      if (stack.length > MAX_DOCUMENT_DEPTH)
        throw new DocumentLimitError(
          "The page is nested too deeply to convert safely. Open it in a browser.",
        );
    }
  }
  const document = createDocument(repairText(source));
  neutralizeInvalidElements(document);
  return document;
}
