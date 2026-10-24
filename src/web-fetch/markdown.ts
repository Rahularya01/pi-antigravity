/**
 * HTML parsing and Markdown rendering belong to Domino and Turndown. This module
 * only chooses page content, resolves links, and reads the crawler's metadata.
 */
import { parseDocument } from "./document.js";
import { mediaKind } from "./media.js";
import { advanceFence, FENCE_LINE, type Fence } from "./fences.js";
import TurndownService from "turndown";
import { tables } from "turndown-plugin-gfm";
import { cleanText } from "../utils/text.js";
import { METADATA_LIMITS } from "./metadata.js";

const markdown = new TurndownService({
  headingStyle: "atx",
  bulletListMarker: "-",
  codeBlockStyle: "fenced",
  emDelimiter: "*",
  hr: "---",
});
markdown.use(tables);
markdown.addRule("inlineCodeText", {
  filter: (node) => node.nodeName === "CODE" && node.parentNode?.nodeName !== "PRE",
  replacement: (_content, node) => {
    const content = (node.textContent ?? "").replace(/\r?\n|\r/g, " ");
    if (!content) return "";
    const matches: string[] = content.match(/`+/g) ?? [];
    let delimiter = "`";
    while (matches.includes(delimiter)) delimiter += "`";
    const padding = /^`|^ .*?[^ ].* $|`$/.test(content) ? " " : "";
    return delimiter + padding + content + padding + delimiter;
  },
});
markdown.addRule("strikethrough", {
  filter: (node) => /^(DEL|S|STRIKE)$/.test(node.nodeName),
  replacement: (content) => `~~${content}~~`,
});
// GFM cells cannot contain block-level Markdown or unescaped pipes.
markdown.addRule("tableCell", {
  filter: ["td", "th"],
  replacement: (content, node) =>
    `${node.previousElementSibling ? " " : "| "}${content
      .trim()
      .replace(/\s*\n\s*/g, " ")
      .replace(/\|/g, "\\|")} |`,
});

const DROPPED_ELEMENTS =
  "script, style, noscript, template, svg, canvas, iframe, form, select, option, button";
const CHROME =
  'nav, aside, footer, .social-icons, .site-footer, .page-footer, .site-header, .site-nav, [role="navigation"], [role="banner"], [role="contentinfo"], [role="search"], [aria-hidden="true"], [hidden]';

export type PageMetadata = {
  title?: string;
  description?: string;
  /** Date the page says it was last modified, exactly as the page states it. */
  updated?: string;
};

/** Collapse line breaks/control characters and bound page-controlled metadata. */
export const sanitizeMetadataText = cleanText;

/** Read metadata through the HTML parser, not a search through attribute text. */
export function extractPageMetadata(html: string, document = parseDocument(html)): PageMetadata {
  const meta = (selector: string) =>
    document.querySelector(selector)?.getAttribute("content")?.trim() || undefined;
  return {
    title: sanitizeMetadataText(
      meta('meta[property="og:title"]') ??
        meta('meta[name="twitter:title"]') ??
        (document.querySelector("title")?.textContent?.trim() || undefined),
      METADATA_LIMITS.title,
    ),
    description: sanitizeMetadataText(
      meta('meta[property="og:description"]') ??
        meta('meta[name="description"]') ??
        meta('meta[name="twitter:description"]'),
      METADATA_LIMITS.description,
    ),
    updated: sanitizeMetadataText(
      meta('meta[property="article:modified_time"]') ??
        meta('meta[property="og:updated_time"]') ??
        meta('meta[name="last-modified"]') ??
        meta('meta[name="lastmod"]'),
      METADATA_LIMITS.updated,
    ),
  };
}

/** Any element name, block-level or inline. */
const HTML_TAG = /<\/?([a-z][a-z0-9:-]*)\b[^>]*>/gi;

/** Elements that never carry a closing tag. */
const HTML_VOID_TAGS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);

const HTML_ELEMENTS = new Set(
  "html head body title meta link script style noscript template main article section header footer nav aside div p span a strong em b i u s del strike code pre blockquote h1 h2 h3 h4 h5 h6 ul ol li dl dt dd table caption thead tbody tfoot tr th td figure figcaption picture img source br hr form label input button select option textarea details summary time address small sub sup abbr cite q mark kbd samp var wbr".split(
    " ",
  ),
);

/**
 * Whether an element's closing tag ends a markup run. Text after the closing tag
 * belongs to the sentence around it ("closed by </p>."), not to the markup.
 */
function closesLikeMarkup(source: string, name: string): boolean {
  const pattern = new RegExp(`</${name}\\s*>`, "gi");
  for (let match = pattern.exec(source); match; match = pattern.exec(source)) {
    const rest = source.slice(match.index + match[0].length);
    const nextMarkup = rest.indexOf("<");
    const tail = nextMarkup < 0 ? rest : rest.slice(0, nextMarkup);
    if (!tail.trim()) return true;
    // Prose can name an opening tag and explain how it is closed. Trailing text
    // alone does not disqualify an otherwise ordinary HTML fragment.
    const explanation = /\b(?:closed|closing|ended)\s+(?:by|with)\s*$/i.test(
      source.slice(0, match.index),
    );
    if (!(explanation && /^[.!?\s]*$/.test(tail))) return true;
  }
  return false;
}

/** Require document markers or element structure, not a prose mention of a tag. */
function hasHtmlStructure(source: string): boolean {
  if (!source.trimStart().startsWith("<")) return false;

  if (/<!doctype\b[^<>]*>|<\/?(?:html|head|body)\b/i.test(source)) return true;
  const first = /^\s*<([a-z][\w:-]*)\b/i.exec(source)?.[1]?.toLowerCase();
  if (first && !HTML_ELEMENTS.has(first)) return false;
  const names = new Set<string>();
  for (const match of source.matchAll(HTML_TAG)) {
    const name = match[1]?.toLowerCase();
    if (name) names.add(name);
  }
  for (const name of names) {
    if (HTML_VOID_TAGS.has(name)) return true;
    if (!new RegExp(`<${name}\\b[^>]*>`, "i").test(source)) continue;
    if (closesLikeMarkup(source, name)) return true;
  }
  return false;
}

/** Leave plain text, JSON, and already-Markdown responses alone. */
export function looksLikeHtml(text: string, contentType?: string): boolean {
  const kind = mediaKind(contentType);
  if (
    kind === "xml" ||
    /^\s*(?:<\?xml\b|<svg\b|<urlset\b|<sitemapindex\b|<feed\b|<rss\b)/i.test(text)
  )
    return false;
  if (kind === "html") return true;
  // An explicit document wrapper outweighs an incorrect text/plain service label.
  if (/^\s*(?:<!doctype\s+html\b|<html\b)/i.test(text)) return true;
  if (kind === "text" || kind === "json" || kind === "pdf") return false;
  if (/^\s*[{"[]/.test(text)) {
    try {
      JSON.parse(text);
      return false;
    } catch {
      // A leading bracket alone does not establish JSON.
    }
  }
  let fence: Fence | undefined;
  const prose: string[] = [];
  for (const line of text.slice(0, 4000).split("\n")) {
    const previous = fence;
    fence = advanceFence(fence, line);
    if (!previous && !fence && !FENCE_LINE.test(line)) prose.push(line);
  }
  const source = prose.join("\n").replace(/(?<!`)(`+)(?!`)[\s\S]*?(?<!`)\1(?!`)/g, "");
  // Markdown can include HTML decorations without becoming an HTML document.
  if (/^ {0,3}#{1,6}\s/m.test(source) && !/<!doctype\b|<(?:html|head|body)\b/i.test(source)) {
    const body = parseDocument(source).body;
    if (
      Array.from(body.childNodes).some(
        (node) => node.nodeType === 3 && /^ {0,3}#{1,6}\s/m.test(node.textContent ?? ""),
      )
    )
      return false;
  }
  return hasHtmlStructure(source);
}

/** Find a tag's closing angle bracket without mistaking a quoted attribute for markup. */
function findMarkupTagEnd(source: string, start: number): number {
  let quote = "";
  let afterEquals = false;
  for (let index = start + 1; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (character === quote) quote = "";
      continue;
    }
    if (character === ">") return index;
    if ((character === "'" || character === '"') && afterEquals) {
      quote = character;
      afterEquals = false;
    } else if (character === "=") {
      afterEquals = true;
    } else if (!/\s/.test(character)) {
      afterEquals = false;
    }
  }
  return -1;
}

export type CopyCompleteness = "complete" | "incomplete" | "unknown";

/**
 * A parsed DOM repairs truncated markup, so completeness must be checked against
 * the original source. Missing document-end tags alone are ambiguous because HTML
 * permits omitting them; a clean end at an element boundary is likewise ambiguous.
 * Unfinished tokens and unclosed article/main regions in full documents are
 * positive signs of truncation; sentence punctuation alone is not.
 */
export function classifyCopyCompleteness(html: string): CopyCompleteness {
  if (!html.trim()) return "complete";
  let index = 0;
  let documentRootSeen = false;
  let rootClosedAtEnd = false;
  let templateDepth = 0;
  let contentDepth = 0;

  while (index < html.length) {
    if (html.startsWith("<!--", index)) {
      const commentEnd = html.indexOf("-->", index + 4);
      if (commentEnd < 0) return "incomplete";
      index = commentEnd + 3;
      continue;
    }
    if (html[index] !== "<") {
      if (!/\s/.test(html[index])) rootClosedAtEnd = false;
      index += 1;
      continue;
    }
    if (index + 1 >= html.length) return "incomplete";
    const next = html[index + 1];
    if (!/[a-z]/i.test(next) && next !== "!" && next !== "?" && next !== "/") {
      rootClosedAtEnd = false;
      index += 1;
      continue;
    }

    const tagEnd = findMarkupTagEnd(html, index);
    if (tagEnd < 0) return "incomplete";
    const tag = html.slice(index, tagEnd + 1);
    const name = /^<\s*\/?\s*([a-z][a-z0-9:-]*)\b/i.exec(tag)?.[1]?.toLowerCase();
    const closing = /^<\s*\//.test(tag);

    if (name === "html" || name === "body" || /^<!doctype\b/i.test(tag)) {
      documentRootSeen = true;
    }
    if (
      closing &&
      (name === "html" || name === "body") &&
      documentRootSeen &&
      templateDepth === 0
    ) {
      rootClosedAtEnd = true;
      index = tagEnd + 1;
      continue;
    }

    rootClosedAtEnd = false;
    if (templateDepth === 0 && (name === "article" || name === "main"))
      contentDepth = Math.max(0, contentDepth + (closing ? -1 : 1));
    if (!closing && name === "template" && !/\/\s*>$/.test(tag)) templateDepth += 1;
    if (closing && name === "template" && templateDepth > 0) templateDepth -= 1;

    if (
      !closing &&
      name &&
      /^(?:script|style|textarea|title|noscript|xmp|iframe|noembed|noframes|plaintext)$/.test(name)
    ) {
      if (name === "plaintext") return "unknown";
      const rawClose = new RegExp("</\\s*" + name + "\\s*>", "ig");
      rawClose.lastIndex = tagEnd + 1;
      const match = rawClose.exec(html);
      if (!match) return "incomplete";
      index = match.index + match[0].length;
      continue;
    }
    index = tagEnd + 1;
  }

  if (rootClosedAtEnd && contentDepth === 0) return "complete";
  return documentRootSeen && contentDepth > 0 ? "incomplete" : "unknown";
}

/** Whether the source has an unambiguously unfinished final HTML token. */
export function isPartialCopy(html: string): boolean {
  return classifyCopyCompleteness(html) === "incomplete";
}

export type HtmlToMarkdownOptions = {
  /** Page URL, used to turn relative links and image sources into absolute ones. */
  baseUrl?: string;
  /** An owned DOM supplied by inspection, before destructive cleanup. */
  document?: Document;
};

/** Where relative links point: the page's `<base href>` when it has a usable one. */
function documentBase(document: Document, baseUrl?: string): string | undefined {
  const href = document.querySelector("base[href]")?.getAttribute("href")?.trim();
  if (!href) return baseUrl;
  try {
    const base = new URL(href, baseUrl);
    return base.protocol === "http:" || base.protocol === "https:" ? base.href : baseUrl;
  } catch {
    return baseUrl;
  }
}

/** Class and id names that mark site chrome rather than page content. */
const CHROME_NAME = /^(?:footer|sidebar|toc|nav|menu|breadcrumb|masthead|social)$/;
/** An element this large a share of the page is the page, whatever its class says. */
const CONTENT_SHARE = 0.4;
const CONTENT_MIN_CHARS = 500;

/**
 * Whether a class-marked element is the page itself. Names such as `has-sidebar`,
 * `menu-open`, or `content-sidebar-wrap` describe state or layout on wrappers that
 * hold the article; only a small, named block is chrome.
 */
function holdsPageText(node: Element, bodyChars: number): boolean {
  if (node.querySelector('h1, main, [role="main"], article')) return true;
  const chars = node.textContent?.length ?? 0;
  return chars >= CONTENT_MIN_CHARS && chars >= bodyChars * CONTENT_SHARE;
}

function resolveTarget(target: string, baseUrl?: string): string {
  try {
    return new URL(target, baseUrl).toString();
  } catch {
    return target;
  }
}

/** Whether the effective inline style hides its element. */
function isHiddenStyle(style: string | null): boolean {
  if (!style) return false;
  // A comment inside the attribute must not hide the declaration behind it.
  const declarations = style.replace(/\/\*[\s\S]*?\*\//g, "").split(";");
  const winners = new Map<string, { value: string; important: boolean }>();
  for (const declaration of declarations) {
    const separator = declaration.indexOf(":");
    if (separator < 0) continue;
    const property = declaration.slice(0, separator).trim().toLowerCase();
    if (property !== "display" && property !== "visibility") continue;
    const raw = declaration.slice(separator + 1);
    const important = /!\s*important\s*$/i.test(raw);
    const value = raw
      .replace(/\s*!\s*important\s*$/i, "")
      .trim()
      .toLowerCase();
    const current = winners.get(property);
    if (!current || important || !current.important) winners.set(property, { value, important });
  }
  const display = winners.get("display")?.value;
  const visibility = winners.get("visibility")?.value;
  return display === "none" || visibility === "hidden" || visibility === "collapse";
}

/** Remove only a dangling tag fragment at the end of a partial page. */
function removeDanglingTailText(node: Node): boolean {
  const children = Array.from(node.childNodes);
  for (let index = children.length - 1; index >= 0; index -= 1) {
    const child = children[index];
    if (child.nodeType === 3) {
      const text = child.textContent ?? "";
      if (!text.trim()) {
        child.remove();
        continue;
      }
      if (/^\s*(?:<\s*|<\/?[a-z][a-z0-9:-]*(?:\s[^<>]*)?\s*)$/i.test(text)) {
        child.remove();
        return true;
      }
      return false;
    }
    if (child.nodeType === 8) continue;
    if (child.nodeType === 1) {
      if (removeDanglingTailText(child)) return true;
      if (!child.textContent?.trim()) continue;
    }
    return false;
  }
  return false;
}

function tableCellHasContent(cell: HTMLTableCellElement): boolean {
  return Boolean(cell.textContent?.trim() || cell.querySelector("img"));
}

function tableRowHasContent(row: HTMLTableRowElement): boolean {
  return Array.from(row.cells).some(tableCellHasContent);
}

function belongsToTable(row: HTMLTableRowElement, table: HTMLTableElement): boolean {
  let ancestor: Node | null = row.parentNode;
  while (ancestor && ancestor !== table) {
    if (ancestor.nodeName === "TABLE") return false;
    ancestor = ancestor.parentNode;
  }
  return ancestor === table;
}

function hasTableAncestor(table: HTMLTableElement): boolean {
  let ancestor: Node | null = table.parentNode;
  while (ancestor) {
    if (ancestor.nodeName === "TABLE") return true;
    ancestor = ancestor.parentNode;
  }
  return false;
}

/** Flatten unsupported grids without discarding links, images, or inline code. */
function flattenTable(table: HTMLTableElement, document: Document): void {
  const flattened = document.createElement("span");
  const caption = table.querySelector("caption");
  if (caption) {
    for (const child of Array.from(caption.childNodes))
      flattened.appendChild(child.cloneNode(true));
    flattened.appendChild(document.createTextNode(" — "));
  }
  const rows = Array.from(table.rows).filter(
    (row) => belongsToTable(row, table) && tableRowHasContent(row),
  );
  rows.forEach((row, rowIndex) => {
    flattened.appendChild(document.createTextNode(rowIndex ? "; " : " "));
    Array.from(row.cells)
      .filter(tableCellHasContent)
      .forEach((cell, cellIndex) => {
        if (cellIndex) flattened.appendChild(document.createTextNode(" — "));
        for (const child of Array.from(cell.childNodes))
          flattened.appendChild(child.cloneNode(true));
      });
  });
  flattened.appendChild(document.createTextNode(" "));
  table.replaceWith(flattened);
}

function flattenNestedTables(root: Element, document: Document): void {
  for (const table of Array.from(root.querySelectorAll("table")).reverse()) {
    if (hasTableAncestor(table)) flattenTable(table, document);
  }
}

const MAX_TABLE_GRID_CELLS = 10_000;

function normalizeTableRows(
  table: HTMLTableElement,
  document: Document,
  maxGridCells: number,
): HTMLTableRowElement[] | undefined {
  const rows = Array.from(table.rows).filter((row) => belongsToTable(row, table));
  const groupEnds = new Map<Node | null, number>();
  rows.forEach((row, index) => groupEnds.set(row.parentNode, index));
  const occupiedUntil = new Map<number, number>();
  const placements: Array<Array<{ cell: HTMLTableCellElement; column: number; span: number }>> =
    rows.map(() => []);
  let width = 0;

  for (const [rowIndex, row] of rows.entries()) {
    let column = 0;
    for (const cell of Array.from(row.cells)) {
      const span = Math.max(1, cell.colSpan);
      for (;;) {
        if ((column + span) * rows.length > maxGridCells) return undefined;
        let blocked: number | undefined;
        for (let offset = 0; offset < span; offset += 1) {
          if ((occupiedUntil.get(column + offset) ?? -1) >= rowIndex) {
            blocked = column + offset;
            break;
          }
        }
        if (blocked === undefined) break;
        column = blocked + 1;
      }
      placements[rowIndex].push({ cell, column, span });
      const remainingRows = groupEnds.get(row.parentNode)! - rowIndex + 1;
      const rowSpan = Math.min(
        remainingRows,
        cell.rowSpan === 0 ? remainingRows : Math.max(1, cell.rowSpan),
      );
      for (let offset = 0; offset < span; offset += 1) {
        occupiedUntil.set(column + offset, rowIndex + rowSpan - 1);
      }
      column += span;
    }
    width = Math.max(width, column);
  }

  rows.forEach((row, rowIndex) => {
    const placed = new Map(placements[rowIndex].map((item) => [item.column, item]));
    const cells: HTMLTableCellElement[] = [];
    for (let column = 0; column < width;) {
      const item = placed.get(column);
      if (item) {
        item.cell.removeAttribute("colspan");
        item.cell.removeAttribute("rowspan");
        cells.push(item.cell);
        for (let offset = 1; offset < item.span; offset += 1) {
          cells.push(document.createElement(item.cell.localName) as HTMLTableCellElement);
        }
        column += item.span;
      } else {
        cells.push(document.createElement("td"));
        column += 1;
      }
    }
    for (const child of Array.from(row.childNodes)) child.remove();
    for (const cell of cells) row.appendChild(cell);
  });

  return rows;
}

/** Read preformatted text while retaining the line breaks represented by <br>. */
function preformattedText(node: Node): string {
  if (node.nodeType === 3) return node.textContent ?? "";
  if (node.nodeName === "BR") return "\n";
  return Array.from(node.childNodes, preformattedText).join("");
}

/** HN's front page uses layout tables, not tabular article data. */
function hackerNewsListing(document: Document, baseUrl?: string): HTMLElement | undefined {
  if (!baseUrl) return undefined;
  const url = new URL(baseUrl);
  if (url.hostname !== "news.ycombinator.com" || !["/", "/news"].includes(url.pathname))
    return undefined;
  const stories = Array.from(document.querySelectorAll("tr.athing")).filter((row) =>
    row.querySelector(".titleline"),
  );
  if (!stories.length) return undefined;
  const main = document.createElement("main");
  const heading = document.createElement("h1");
  heading.textContent = document.title;
  main.appendChild(heading);
  const list = document.createElement("ol");
  for (const row of stories) {
    const item = document.createElement("li");
    item.appendChild(row.querySelector(".titleline")!.cloneNode(true));
    const metadata = row.nextElementSibling?.querySelector(".subtext");
    if (metadata) {
      item.appendChild(document.createTextNode(" — "));
      for (const child of Array.from(metadata.childNodes)) item.appendChild(child.cloneNode(true));
    }
    list.appendChild(item);
  }
  main.appendChild(list);
  const more = document.querySelector("a.morelink");
  if (more) main.appendChild(more.cloneNode(true));
  return main;
}

/** Convert the page's content; the DOM parser also repairs incomplete crawler copies. */
export function htmlToMarkdown(
  html: string,
  { baseUrl, document = parseDocument(html) }: HtmlToMarkdownOptions = {},
): string {
  if (!html) return "";
  const linkBase = documentBase(document, baseUrl);
  // Mozilla Readability recommends isolating its mutating extraction on a clone (Apache-2.0):
  // https://github.com/mozilla/readability. This parse already owns a disposable DOM.
  for (const node of Array.from(document.querySelectorAll(DROPPED_ELEMENTS))) node.remove();
  for (const node of Array.from(document.querySelectorAll("[hidden], [aria-hidden], [style]"))) {
    if (
      node.hasAttribute("hidden") ||
      node.getAttribute("aria-hidden")?.trim().toLowerCase() === "true" ||
      isHiddenStyle(node.getAttribute("style"))
    ) {
      node.remove();
    }
  }
  for (const node of Array.from(document.body.querySelectorAll(CHROME))) node.remove();
  const bodyChars = document.body.textContent?.length ?? 0;
  for (const node of Array.from(
    document.body.querySelectorAll("div, section, ul, ol, header, footer, aside, nav"),
  )) {
    const names = `${node.getAttribute("id") ?? ""} ${node.getAttribute("class") ?? ""}`
      .toLowerCase()
      .split(/\s+/)
      .filter((name) => !/[:[\]/]/.test(name));
    if (
      names.some((name) => name.split(/[_-]+/).some((piece) => CHROME_NAME.test(piece))) &&
      !holdsPageText(node, bodyChars)
    )
      node.remove();
  }
  // Empty/hidden placeholders are not content roots. Prefer the substantive region,
  // not whichever <main> happens to occur first.
  const regions = Array.from(
    document.querySelectorAll<HTMLElement>('main, [role="main"], article'),
  );
  regions.sort((a, b) => (b.textContent?.trim().length ?? 0) - (a.textContent?.trim().length ?? 0));
  const root =
    hackerNewsListing(document, baseUrl) ??
    regions.find((node) => node.textContent?.trim()) ??
    document.body;
  if (isPartialCopy(html)) removeDanglingTailText(root);

  for (const link of Array.from(root.querySelectorAll("a"))) {
    link.removeAttribute("title");
    const href = link.getAttribute("href")?.trim();
    const textLabel = link.textContent?.trim() ?? "";
    const ariaLabel = link.getAttribute("aria-label")?.trim() ?? "";
    if (!textLabel && ariaLabel) link.textContent = ariaLabel;
    const label = textLabel || ariaLabel;
    if (!label && !link.querySelector("img")) {
      link.remove();
      continue;
    }
    if (href?.startsWith("#") && (!/[\p{L}\p{N}]/u.test(label) || /^skip\b/i.test(label))) {
      link.remove();
    } else if (
      href?.startsWith("#") ||
      /^(?:javascript|vbscript|data):/i.test(href?.replace(/\s/g, "") ?? "")
    ) {
      link.removeAttribute("href");
    } else if (href) {
      link.setAttribute("href", resolveTarget(href, linkBase));
      if (
        link.childNodes.length === 1 &&
        link.firstChild === link.firstElementChild &&
        link.firstElementChild?.tagName === "IMG"
      ) {
        link.removeAttribute("href");
      } else if (label === href || label === link.getAttribute("href")) {
        link.replaceWith(document.createTextNode(link.getAttribute("href")!));
      }
    }
  }
  for (const image of Array.from(root.querySelectorAll("img"))) {
    image.removeAttribute("title");
    const src = image.getAttribute("src")?.trim();
    if (!src || /^(?:data|javascript|vbscript):/i.test(src.replace(/\s/g, ""))) image.remove();
    else image.setAttribute("src", resolveTarget(src, linkBase));
  }
  for (const link of Array.from(root.querySelectorAll("a"))) {
    if (!link.textContent?.trim() && !link.querySelector("img")) link.remove();
  }
  for (const item of Array.from(root.querySelectorAll("li"))) {
    if (!item.textContent?.trim() && !item.querySelector("img")) item.remove();
  }

  // Turndown's fenced-code rule expects <pre><code>...</code></pre>.
  for (const pre of Array.from(root.querySelectorAll("pre"))) {
    const text = preformattedText(pre);
    if (pre.childNodes.length === 1 && pre.firstChild?.nodeName === "CODE") {
      pre.firstChild.textContent = text;
      continue;
    }
    const code = document.createElement("code");
    code.textContent = text;
    pre.textContent = "";
    pre.appendChild(code);
  }
  flattenNestedTables(root, document);
  // Give the GFM plugin a rectangular table with an explicit header section.
  let remainingTableCells = MAX_TABLE_GRID_CELLS;
  for (const table of Array.from(root.querySelectorAll("table"))) {
    const normalized = normalizeTableRows(table, document, remainingTableCells);
    if (!normalized) {
      flattenTable(table, document);
      continue;
    }
    remainingTableCells -= normalized.length * (normalized[0]?.cells.length ?? 0);
    const rows = normalized.filter(tableRowHasContent);
    if (!rows.length || (!table.textContent?.trim() && !table.querySelector("img"))) {
      table.remove();
      continue;
    }
    const width = rows[0].cells.length;
    const first = rows[0];
    const header = Array.from(first.cells).every((cell) => cell.tagName === "TH")
      ? rows.shift()!
      : document.createElement("tr");
    for (let column = header.cells.length; column < width; column += 1)
      header.appendChild(document.createElement("th"));
    const head = document.createElement("thead");
    const body = document.createElement("tbody");
    head.appendChild(header);
    for (const row of rows) body.appendChild(row);
    const sourceCaption = table.querySelector("caption");
    if (sourceCaption) {
      const caption = document.createElement("p");
      for (const child of Array.from(sourceCaption.childNodes))
        caption.appendChild(child.cloneNode(true));
      table.parentNode!.insertBefore(caption, table);
    }
    table.textContent = "";
    table.appendChild(head);
    table.appendChild(body);
  }

  return convertBlocks(root);
}

/**
 * Turndown joins a growing string at every sibling, repeatedly scanning the entire
 * prefix for trailing newlines. Convert independent blocks separately; keep inline,
 * list and table contexts together so their Markdown semantics remain intact.
 */
function convertBlocks(root: HTMLElement): string {
  const containers = /^(BODY|DIV|MAIN|ARTICLE|SECTION|HEADER|FOOTER|ASIDE|NAV)$/;
  const block =
    /^(P|H[1-6]|UL|OL|PRE|TABLE|BLOCKQUOTE|DIV|SECTION|MAIN|ARTICLE|HR|DL|FIGURE|HEADER|FOOTER|ASIDE|NAV)$/;
  const children = Array.from(root.childNodes);
  if (
    containers.test(root.nodeName) &&
    children.every(
      (node) =>
        node.nodeType === 8 ||
        (node.nodeType === 3 && !node.textContent?.trim()) ||
        (node.nodeType === 1 && block.test(node.nodeName)),
    )
  ) {
    return children
      .filter((node): node is HTMLElement => node.nodeType === 1)
      .map(convertBlocks)
      .filter(Boolean)
      .join("\n\n");
  }
  // turndown(element) converts its children, not the element itself.
  const wrapper = root.ownerDocument.createElement("div");
  wrapper.appendChild(root.cloneNode(true));
  return markdown.turndown(wrapper).trim();
}
