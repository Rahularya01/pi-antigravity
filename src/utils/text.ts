/**
 * Shared handling for text that came from somewhere else: a page, the fetch service,
 * or a quota report.
 *
 * Two operations with two scopes:
 * - {@link repairText} keeps structure and length, replacing only ill-formed UTF-16.
 *   It applies to every third-party string, including page bodies.
 * - {@link cleanText} flattens a value to one bounded line. It applies only to labels
 *   and metadata, never to a page body, whose line structure is the content.
 *
 * The length cuts never split a surrogate pair. Each caller chooses the direction:
 * an end that must stay inside a limit moves back, a range end moves forward, and a
 * range start moves back.
 */
import { sanitizeText } from "./util.js";

/** Replace lone surrogates with U+FFFD. One code unit in, one code unit out. */
export function repairText(text: string): string {
  return sanitizeText(text);
}

/** Whether index falls between the two halves of a surrogate pair. */
export function splitsPair(text: string, index: number): boolean {
  if (index <= 0 || index >= text.length) return false;
  const before = text.charCodeAt(index - 1);
  const after = text.charCodeAt(index);
  return before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff;
}

/** Move a boundary back off a surrogate pair. */
export function boundaryBack(text: string, index: number): number {
  return splitsPair(text, index) ? index - 1 : index;
}

/** Move a boundary forward off a surrogate pair. */
export function boundaryForward(text: string, index: number): number {
  return splitsPair(text, index) ? index + 1 : index;
}

/** Cut text to at most limit code units without splitting a character. */
export function capText(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return text.slice(0, boundaryBack(text, Math.max(0, limit)));
}

/** One bounded, single-line value: control characters and line breaks become spaces. */
export function cleanText(value: string | undefined, limit: number): string | undefined {
  if (!value) return undefined;
  const cleaned = repairText(value)
    .replace(/[\p{Cc}\u2028\u2029]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return undefined;
  if (cleaned.length <= limit) return cleaned;
  return `${capText(cleaned, Math.max(0, limit - 1))}…`;
}

/** Keep the head and the tail of a long value, eliding the middle. */
export function elideMiddle(value: string, limit: number): string {
  if (value.length <= limit) return value;
  if (limit < 3) return capText(value, limit);
  const keep = limit - 1;
  const headEnd = boundaryBack(value, Math.ceil(keep / 2));
  const tailStart = boundaryForward(value, value.length - (keep - Math.ceil(keep / 2)));
  return `${value.slice(0, headEnd)}…${value.slice(tailStart)}`;
}
