/**
 * A fuller copy of a page that its publisher serves at another URL.
 *
 * Retrieval does not care which kind it has: it fetches `url`, passes the response to
 * `read`, and inspects the document that comes back. Each kind owns its identity
 * checks, so a copy is used only when it names the requested page, and never rebuilt
 * from partial data.
 */
import { articleRepresentation, type PageInspection } from "./inspect.js";
import { inspectMdnRepresentation, mdnRepresentationUrl } from "./mdn.js";
import { mediaKind } from "./media.js";
import { siteRepresentation } from "./sites.js";

export type RepresentationDocument = {
  /** HTML or text to inspect. */
  body: string;
  /** Media type of `body`; unset when it is HTML decoded out of a JSON envelope. */
  contentType?: string;
  /** The article this document is for, when the publisher names a canonical URL. */
  articleUrl?: string;
  /** Set when the representation itself proves the document whole or cut off. */
  completeness?: PageInspection["completeness"];
  notes?: string[];
  metadata?: PageInspection["metadata"];
  language?: string;
};

export type Representation = {
  url: string;
  /**
   * Resolve Google's redirect for `url` first. Links a page advertises need it, so they
   * cannot leave the page's origin; a URL built from the page's own address does not.
   */
  resolve: boolean;
  /** Language the publisher declared for this copy. */
  language?: string;
  /** The document in a response, or undefined when it is not the expected one. */
  read(
    content: string,
    reportedType: string | undefined,
    articleUrl: string,
  ): RepresentationDocument | undefined;
};

type Advertised = PageInspection["alternates"][number];

function advertised(alternate: Advertised): Representation {
  return {
    url: alternate.url,
    resolve: true,
    language: alternate.language,
    read(content, reportedType, articleUrl) {
      const json =
        mediaKind(reportedType) === "json" ||
        (alternate.type === "application/json" && /^\s*[{[]/.test(content));
      if (!json) return { body: content, contentType: reportedType };
      const body = articleRepresentation(content, articleUrl);
      return body === undefined ? undefined : { body };
    },
  };
}

function mdn(url: string): Representation {
  return {
    url,
    resolve: true,
    read(content, _reportedType, articleUrl) {
      const article = inspectMdnRepresentation(content, articleUrl);
      return (
        article && {
          body: article.html,
          articleUrl: article.resolvedUrl,
          completeness: article.completeness,
          notes: article.notes,
          metadata: article.metadata,
          language: article.metadata.language,
        }
      );
    },
  };
}

/** The copy to try when the page itself is cut off or unavailable. */
export function representationFor(
  articleUrl: string,
  alternate?: Advertised,
): Representation | undefined {
  if (alternate) return advertised(alternate);
  const site = siteRepresentation(articleUrl);
  if (site) return site;
  const url = mdnRepresentationUrl(articleUrl);
  return url ? mdn(url) : undefined;
}
