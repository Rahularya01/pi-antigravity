import { parseDocument } from "./document.js";
import { cleanText } from "../utils/text.js";
import { METADATA_LIMITS } from "./metadata.js";
import { isRecord } from "../utils/util.js";
import type { PageInspection } from "./inspect.js";

/** MDN's observed article-data representation; no cross-origin or guessed source-repo mapping. */
export function mdnRepresentationUrl(articleUrl: string): string | undefined {
  const url = new URL(articleUrl);
  if (
    url.origin !== "https://developer.mozilla.org" ||
    url.search ||
    !/^\/[a-z]{2,3}(?:-[a-z0-9]{2,8})*\/docs\/.+/i.test(url.pathname) ||
    /\.(?:json|md|txt)\/?$/i.test(url.pathname)
  )
    return undefined;
  url.pathname = url.pathname.replace(/\/$/, "") + "/index.json";
  url.hash = "";
  return url.href;
}

/**
 * Read only verified MDN article data. Google's copy can end inside sidebarHTML:
 * in that case parse the strictly valid document prefix before that property.
 * Never repair an unfinished article body or synthesize missing section content.
 */
export function inspectMdnRepresentation(
  content: string,
  articleUrl: string,
):
  | {
      html: string;
      resolvedUrl: string;
      completeness: PageInspection["completeness"];
      metadata: PageInspection["metadata"];
      notes: string[];
    }
  | undefined {
  if (!mdnRepresentationUrl(articleUrl) || content.length > 2_000_000) return undefined;
  let value: unknown;
  let completeness: PageInspection["completeness"] = "unknown";
  try {
    value = JSON.parse(content);
  } catch {
    // This schema places body and mdn_url before the large, unrelated sidebar.
    const sidebar = /,\s*"sidebarHTML"\s*:/.exec(content);
    if (!sidebar) return undefined;
    try {
      value = JSON.parse(content.slice(0, sidebar.index) + "}}");
      completeness = "incomplete";
    } catch {
      return undefined;
    }
  }
  if (!isRecord(value) || !isRecord(value.doc)) return undefined;
  const doc = value.doc;
  const pageTitle =
    typeof doc.title === "string"
      ? doc.title
      : typeof doc.short_title === "string"
        ? doc.short_title
        : undefined;
  if (
    typeof doc.mdn_url !== "string" ||
    !Array.isArray(doc.body) ||
    !doc.body.length ||
    pageTitle === undefined
  )
    return undefined;
  const expected = new URL(articleUrl);
  let identity: URL;
  try {
    identity = new URL(doc.mdn_url, expected);
  } catch {
    return undefined;
  }
  if (
    identity.username ||
    identity.password ||
    identity.origin !== expected.origin ||
    !mdnRepresentationUrl(identity.href) ||
    !identity.pathname.startsWith(expected.pathname.match(/^\/[^/]+\/docs\//)![0]) ||
    identity.search ||
    identity.hash
  )
    return undefined;
  const document = parseDocument("<html><body><main></main></body></html>");
  const notes: string[] = [];
  const omitted = new Set<string>();
  const main = document.querySelector("main")!;
  const title = document.createElement("h1");
  title.textContent = pageTitle;
  main.appendChild(title);
  for (const section of doc.body) {
    if (!isRecord(section) || !isRecord(section.value)) {
      omitted.add("unrecognized");
      continue;
    }
    const data = section.value;
    if (section.type !== "prose" && section.type !== "specifications") {
      omitted.add(cleanText(typeof section.type === "string" ? section.type : "unrecognized", 60)!);
      continue;
    }
    if (typeof data.title === "string" && data.title) {
      const heading = document.createElement(data.isH3 === true ? "h3" : "h2");
      heading.textContent = data.title;
      main.appendChild(heading);
    }
    if (section.type === "prose") {
      if (typeof data.content !== "string") return undefined;
      const block = document.createElement("div");
      const sectionDocument = parseDocument(data.content);
      for (const child of Array.from(sectionDocument.body.childNodes))
        block.appendChild(document.importNode(child, true));
      main.appendChild(block);
    } else {
      if (!Array.isArray(data.specifications)) return undefined;
      const list = document.createElement("ul");
      for (const spec of data.specifications) {
        if (
          !isRecord(spec) ||
          typeof spec.title !== "string" ||
          typeof spec.bcdSpecificationURL !== "string"
        )
          return undefined;
        let href: URL;
        try {
          href = new URL(spec.bcdSpecificationURL, expected);
        } catch {
          return undefined;
        }
        if (href.protocol !== "https:" && href.protocol !== "http:") return undefined;
        const item = document.createElement("li");
        const link = document.createElement("a");
        link.href = href.href;
        link.textContent = spec.title;
        item.appendChild(link);
        list.appendChild(item);
      }
      main.appendChild(list);
    }
  }
  if (omitted.size) {
    completeness = "incomplete";
    notes.push(`Publisher sections omitted: ${[...omitted].join(", ")}.`);
  }
  return {
    html: document.documentElement.outerHTML,
    notes,
    resolvedUrl: identity.href,
    completeness,
    metadata: {
      title: cleanText(pageTitle, METADATA_LIMITS.title),
      updated: cleanText(
        typeof doc.modified === "string" ? doc.modified : undefined,
        METADATA_LIMITS.updated,
      ),
      language: cleanText(
        typeof doc.locale === "string" ? doc.locale : undefined,
        METADATA_LIMITS.language,
      ),
    },
  };
}
