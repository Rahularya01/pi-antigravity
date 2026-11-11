/** Media types have one owner for detection and PDF refusal. */
export type MediaKind = "html" | "text" | "json" | "xml" | "pdf" | "unknown";
export function mediaKind(value?: string): MediaKind {
  const type = value?.split(";")[0].trim().toLowerCase() ?? "";
  if (type === "text/html" || type === "application/xhtml+xml") return "html";
  if (type === "application/pdf") return "pdf";
  if (type === "application/json" || type.endsWith("+json")) return "json";
  if (type === "text/xml" || type === "application/xml" || type.endsWith("+xml")) return "xml";
  if (["text/plain", "text/markdown", "text/x-markdown"].includes(type)) return "text";
  return "unknown";
}
