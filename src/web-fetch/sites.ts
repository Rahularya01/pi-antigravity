/**
 * Fuller same-publisher copies for sites whose ordinary pages Google cuts short.
 *
 * Google's copy of a Wikipedia article can stop in its header, and raw GitHub files stop
 * after a third or so of the file. Each site publishes the same document in another
 * form that Google returns whole. Like the MDN recovery, a copy is used only after its
 * identity is verified against the requested page, and never reconstructed.
 */
import { isRecord } from "../utils/util.js";
import type { Representation } from "./representation.js";

function decodedPath(value: string): string | undefined {
  try {
    return decodeURIComponent(value).replace(/ /g, "_");
  } catch {
    return undefined;
  }
}

/** MediaWiki capitalizes the first letter of a title, so `unix_philosophy` is `Unix philosophy`. */
function sameTitle(a: string, b: string): boolean {
  const normal = (title: string) => {
    const spaced = title.replace(/ /g, "_");
    return spaced.charAt(0).toUpperCase() + spaced.slice(1);
  };
  return normal(a) === normal(b);
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Wikipedia's parse API for `https://<lang>.wikipedia.org/wiki/<title>`. Its JSON
 * names the article, and a JSON document that parses is not cut off.
 */
function wikipedia(url: URL): Representation | undefined {
  const segment = /^\/wiki\/(.+)$/.exec(url.pathname)?.[1];
  if (!/^[a-z0-9-]+\.wikipedia\.org$/.test(url.hostname) || url.search || !segment)
    return undefined;
  const title = decodedPath(segment);
  if (!title || /^Special:/i.test(title)) return undefined;
  const api = new URL("/w/api.php", url.origin);
  api.search = new URLSearchParams({
    action: "parse",
    page: title,
    prop: "text",
    format: "json",
    formatversion: "2",
    redirects: "1",
    disableeditsection: "1",
    disabletoc: "1",
  }).toString();
  return {
    url: api.href,
    resolve: false,
    read(content) {
      let data: unknown;
      try {
        data = JSON.parse(content);
      } catch {
        return undefined;
      }
      const parse = isRecord(data) && isRecord(data.parse) ? data.parse : undefined;
      if (!parse || typeof parse.title !== "string" || typeof parse.text !== "string")
        return undefined;
      const names = [
        parse.title,
        ...(Array.isArray(parse.redirects)
          ? parse.redirects.map((item) => (isRecord(item) ? item.from : undefined))
          : []),
      ];
      // The article must be the requested one, directly or through its redirect.
      if (!names.some((name) => typeof name === "string" && sameTitle(name, title)))
        return undefined;
      const heading = escapeHtml(parse.title);
      return {
        body: `<!doctype html><html><head><title>${heading}</title></head><body><main><h1>${heading}</h1>${parse.text}</main></body></html>`,
        contentType: "text/html",
        completeness: "complete",
      };
    },
  };
}

/** GitHub's file page for `https://raw.githubusercontent.com/<owner>/<repo>/<ref>/<path>`. */
function githubRaw(url: URL): Representation | undefined {
  const parts = url.pathname.split("/").slice(1);
  if (url.hostname !== "raw.githubusercontent.com" || url.search || parts.length < 4)
    return undefined;
  if (parts.some((part) => !part)) return undefined;
  const [owner, repository, ...rest] = parts;
  const blob = `https://github.com/${owner}/${repository}/blob/${rest.join("/")}`;
  return {
    url: blob,
    resolve: false,
    read(content) {
      const embedded =
        /<script type="application\/json" data-target="react-app\.embeddedData">([\s\S]*?)<\/script>/.exec(
          content,
        )?.[1];
      if (!embedded) return undefined;
      let data: unknown;
      try {
        data = JSON.parse(embedded);
      } catch {
        return undefined;
      }
      const payload = isRecord(data) && isRecord(data.payload) ? data.payload : undefined;
      const route =
        payload && isRecord(payload.codeViewBlobLayoutRoute)
          ? payload.codeViewBlobLayoutRoute
          : undefined;
      const styled = payload?.["codeViewBlobLayoutRoute.StyledBlob"];
      const file = route && isRecord(route.blob) ? route.blob : undefined;
      const lines = isRecord(styled) ? styled.rawLines : undefined;
      // The file page must name the requested file, and carry all of its lines.
      const requested = `/${rest.join("/")}`;
      if (
        !route ||
        !file ||
        typeof route.path !== "string" ||
        !requested.endsWith(`/${route.path}`) ||
        file.truncated !== false ||
        !Array.isArray(lines) ||
        !lines.every((line) => typeof line === "string")
      )
        return undefined;
      return { body: lines.join("\n"), contentType: "text/plain", completeness: "complete" };
    },
  };
}

/** A fuller copy the publisher serves for this page, when one is known. */
export function siteRepresentation(articleUrl: string): Representation | undefined {
  const url = new URL(articleUrl);
  return wikipedia(url) ?? githubRaw(url);
}
