import { parseDocument } from "./document.js";
import { advanceFence, FENCE_LINE, type Fence } from "./fences.js";
import { repairText } from "../utils/text.js";
import { isRecord } from "../utils/util.js";
import { METADATA_LIMITS } from "./metadata.js";
import {
  classifyCopyCompleteness,
  extractPageMetadata,
  htmlToMarkdown,
  looksLikeHtml,
  sanitizeMetadataText,
} from "./markdown.js";

export type ContentAssessment = "readable" | "empty" | "suspected-shell" | "suspected-access-wall";

export type PageInspection = {
  rendered: string;
  completeness: "complete" | "incomplete" | "unknown";
  assessment: ContentAssessment;
  notes?: string[];
  metadata: ReturnType<typeof extractPageMetadata> & {
    author?: string;
    published?: string;
    language?: string;
  };
  alternates: Array<{
    url: string;
    type: "text/markdown" | "application/json";
    language?: string;
  }>;
};

function normalizedWallHeading(value: string): string {
  return value
    .replace(/\s*[|•–—-]\s*cloudflare\s*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Headings that are a wall on their own. They stay exact: "429 Too Many Requests"
 * is also the title of a real article about that status, and "Forbidden error
 * handling" is a real article title.
 */
const ACCESS_WALL_HEADINGS = [
  "forbidden",
  "403 forbidden",
  "unauthorized",
  "401 unauthorized",
  "access denied",
];

/**
 * Openings of the interstitials that stand in for an article. The heading of a real
 * wall usually carries more than the phrase itself ("Please enable JavaScript to
 * continue"), so a phrase that opens the heading marks a wall.
 */
const ACCESS_WALL_OPENINGS = [
  "just a moment",
  "just a second",
  "one more step",
  "robot or human",
  "please wait while we verify",
  "access to this page has been denied",
  "you don't have permission",
  "verifying your browser",
  "too many requests",
  "verify you are human",
  "verifying you are human",
  "attention required",
  "you have been blocked",
  "sorry, you have been blocked",
  "checking your browser",
  "security check",
  "enable javascript",
  "please enable javascript",
  "javascript is required",
  "javascript required",
  "are you a robot",
  "unusual traffic",
  "request blocked",
  "rate limited",
  "you are being rate limited",
];

/** Sign-in pages read like a wall, but an article title may also start with one. */
const ACCESS_WALL_SIGN_IN_OPENINGS = ["sign in", "log in"];

/** How much text may follow the wall phrase before the heading is an article title. */
const ACCESS_WALL_TAIL = 40;
const ACCESS_WALL_SIGN_IN_TAIL = 24;

/** A short block/sign-in heading, not an article that happens to discuss one. */
function isAccessWallHeading(value: string | undefined): boolean {
  if (!value) return false;
  const text = normalizedWallHeading(value).toLowerCase();
  if (!text) return false;
  if (ACCESS_WALL_HEADINGS.includes(text.replace(/[.!…\s]*$/, ""))) return true;
  const opens = (opening: string, tail: number) =>
    text.startsWith(opening) &&
    (text.length - opening.length <= tail || /browser|human|verify|access/.test(text));
  return (
    ACCESS_WALL_OPENINGS.some((opening) => opens(opening, ACCESS_WALL_TAIL)) ||
    ACCESS_WALL_SIGN_IN_OPENINGS.some((opening) => opens(opening, ACCESS_WALL_SIGN_IN_TAIL))
  );
}

/** A wall heading alone cannot overrule substantial article content. */
function hasArticleContent(rendered: string): boolean {
  const body = rendered.replace(/^#{1,6} .*$/gm, "").trim();
  return (
    (body.length >= 500 && /[.!?:]/.test(body)) ||
    (body.length >= 80 && /\b(?:HTTP|status code|response|client|server)\b/i.test(body))
  );
}

function isLoadingShell(rendered: string): boolean {
  const visible = rendered.replace(/^#{1,6} .*$/gm, "").trim();
  return /^(?:loading|please wait|redirecting|initializing)[.!…\s]*$/i.test(visible);
}

/** Match structured data to this page without treating fragments as separate pages. */
function pageIdentity(value: unknown, baseUrl: string): string | undefined {
  if (isRecord(value)) value = value["@id"];
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value, baseUrl);
    url.hash = "";
    return url.href;
  } catch {
    return undefined;
  }
}

/** Inspect data before destructive Markdown cleanup; never execute page scripts. */
export function inspectPage(content: string, url: string, contentType?: string): PageInspection {
  if (!looksLikeHtml(content, contentType)) {
    const rendered = repairText(content).trim();
    let title: string | undefined;
    let fence: Fence | undefined;
    for (const line of rendered.split("\n")) {
      const previous = fence;
      fence = advanceFence(fence, line);
      if (!previous && !fence && !FENCE_LINE.test(line)) {
        title = /^ {0,3}# +(.+?)(?: +#+)?\s*$/.exec(line)?.[1];
        if (title) break;
      }
    }
    return {
      rendered,
      completeness: "unknown",
      assessment: rendered ? "readable" : "empty",
      metadata: { title: sanitizeMetadataText(title, 300) },
      alternates: [],
    };
  }
  const document = parseDocument(content);
  const metadata: PageInspection["metadata"] = extractPageMetadata(content, document);
  metadata.language = sanitizeMetadataText(document.documentElement.lang || undefined, 50);
  const nodes: Record<string, unknown>[] = [];
  let budget = 256_000;
  for (const script of Array.from(
    document.querySelectorAll('script[type="application/ld+json"]'),
  ).slice(0, 16)) {
    const text = script.textContent ?? "";
    budget -= text.length;
    if (budget < 0) break;
    try {
      const value: unknown = JSON.parse(text);
      const roots = Array.isArray(value) ? value : [value];
      for (const root of roots) {
        if (!isRecord(root)) continue;
        nodes.push(root);
        if (Array.isArray(root["@graph"])) nodes.push(...root["@graph"].filter(isRecord));
      }
    } catch {
      // Invalid or truncated structured data is not evidence.
    }
  }
  const identity = pageIdentity(url, url);
  const article = nodes.find((node) => {
    const types = Array.isArray(node["@type"]) ? node["@type"] : [node["@type"]];
    return (
      types.some(
        (type) =>
          typeof type === "string" && /^(Article|NewsArticle|BlogPosting|TechArticle)$/.test(type),
      ) &&
      [node.url, node.mainEntityOfPage, node["@id"]].some(
        (value) => pageIdentity(value, url) === identity,
      )
    );
  });
  if (article) {
    const text = (value: unknown, field: keyof typeof METADATA_LIMITS) =>
      typeof value === "string" && value.trim()
        ? sanitizeMetadataText(value, METADATA_LIMITS[field])
        : undefined;
    metadata.title ??= text(article.headline, "title");
    metadata.description ??= text(article.description, "description");
    metadata.updated ??= text(article.dateModified, "updated");
    metadata.published = text(article.datePublished, "published");
    metadata.language ??= text(article.inLanguage, "language");
    const author: unknown = Array.isArray(article.author) ? article.author[0] : article.author;
    const person: unknown =
      isRecord(author) && !author.name && typeof author["@id"] === "string"
        ? nodes.find((node) => node["@id"] === author["@id"])
        : author;
    metadata.author = isRecord(person) ? text(person.name, "author") : text(person, "author");
  }

  const alternates: PageInspection["alternates"] = [];
  for (const link of Array.from(document.querySelectorAll("link[href][type]"))) {
    if (!(link.getAttribute("rel") ?? "").toLowerCase().split(/\s+/).includes("alternate"))
      continue;
    const type = link.getAttribute("type")?.split(";")[0].toLowerCase().trim();
    if (type !== "text/markdown" && type !== "application/json") continue;
    try {
      const alternate = new URL(link.getAttribute("href")!, url);
      if (alternate.origin !== new URL(url).origin || alternate.username || alternate.password)
        continue;
      if (/\.pdf$/i.test(alternate.pathname)) continue;
      alternate.hash = "";
      if (alternate.href === identity || alternates.some((item) => item.url === alternate.href))
        continue;
      const language = sanitizeMetadataText(
        link.getAttribute("hreflang") ?? undefined,
        35,
      )?.toLowerCase();
      const declaredLanguage = language && language !== "x-default" ? language : undefined;
      alternates.push({
        url: alternate.href,
        type,
        ...(declaredLanguage ? { language: declaredLanguage } : {}),
      });
    } catch {
      // Ignore invalid URLs, including malformed base-relative references.
    }
  }
  const pageLanguage = metadata.language?.split("-")[0].toLowerCase();
  const sameLanguage = pageLanguage
    ? alternates.filter((item) => !item.language || item.language.split("-")[0] === pageLanguage)
    : alternates;
  const preferred = sameLanguage.length ? sameLanguage : alternates;
  preferred.sort((a, b) => Number(b.type === "text/markdown") - Number(a.type === "text/markdown"));
  const appScript = Boolean(document.querySelector('script[src], script[type="module"]'));
  const rendered = htmlToMarkdown(content, { baseUrl: url, document });
  const heading = /^# +(.+)$/m.exec(rendered)?.[1] || "";
  // A page that loads an application script and shows nothing else is a shell.
  const completeness = classifyCopyCompleteness(content);
  // A page that loads application JavaScript and shows only a placeholder is a shell.
  // A cut-off copy holding only a heading has lost its body; report it as empty.
  const bodyMissing =
    !rendered.trim() ||
    (completeness === "incomplete" && !rendered.replace(/^#{1,6} .*$/gm, "").trim());
  const assessment: ContentAssessment = bodyMissing
    ? // A copy that ends before the content is cut off, not an application shell.
      appScript && completeness !== "incomplete"
      ? "suspected-shell"
      : "empty"
    : isAccessWallHeading(heading || metadata.title) &&
        /\b(?:check(?:ing)?|verif\w*|captcha|blocked|denied|permission|enable javascript|sign in|log in)\b/i.test(
          rendered.replace(/^#{1,6} .*$/gm, ""),
        ) &&
        !hasArticleContent(rendered)
      ? "suspected-access-wall"
      : appScript && isLoadingShell(rendered)
        ? "suspected-shell"
        : "readable";
  return {
    rendered,
    completeness,
    assessment,
    metadata,
    alternates: preferred.slice(0, 8),
  };
}

/**
 * Inspection of a source the converter will not take on. Raw mode returns the crawled
 * source as it is, so the page's size limits the answer, not the read.
 */
export function inspectUnconverted(content: string, reason: string): PageInspection {
  return {
    rendered: "",
    completeness: classifyCopyCompleteness(content),
    assessment: content.trim() ? "readable" : "empty",
    notes: [`Not converted: ${reason}`],
    metadata: {},
    alternates: [],
  };
}

/** Decode only explicit article-body JSON shapes from an advertised representation. */
export function articleRepresentation(content: string, articleUrl: string): string | undefined {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    return undefined;
  }
  if (!isRecord(value)) return undefined;
  // GitHub Docs article API.
  if (
    isRecord(value.meta) &&
    value.meta.documentType === "article" &&
    typeof value.body === "string" &&
    Array.isArray(value.meta.breadcrumbs)
  ) {
    const current: unknown = value.meta.breadcrumbs.at(-1);
    if (
      isRecord(current) &&
      pageIdentity(current.href, articleUrl) === pageIdentity(articleUrl, articleUrl)
    )
      return value.body;
  }
  // WordPress single-post REST representation (not an index or oEmbed summary).
  if (
    typeof value.id === "number" &&
    typeof value.link === "string" &&
    pageIdentity(value.link, articleUrl) === pageIdentity(articleUrl, articleUrl) &&
    isRecord(value.content) &&
    value.content.protected !== true &&
    typeof value.content.rendered === "string"
  ) {
    return value.content.rendered;
  }
  return undefined;
}
