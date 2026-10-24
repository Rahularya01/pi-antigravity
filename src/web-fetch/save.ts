/**
 * Keep a page too long for one answer on disk, the way Pi's own tools keep long output:
 * the caller shows the beginning and points to the file for the rest.
 *
 * Saving is a convenience around a read that already succeeded, so it never throws: a
 * failure becomes part of the answer, and the page that was read is not lost with it.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { redactSecrets } from "../utils/security.js";
import { cleanText } from "../utils/text.js";

export type SavedPage = { ok: true; path: string } | { ok: false; reason: string };

const DIRECTORY_PREFIX = "pi-url-";

/** Write text to a new private temp directory. */
export async function savePage(text: string, extension: "md" | "html" | "txt"): Promise<SavedPage> {
  let directory: string | undefined;
  try {
    directory = await mkdtemp(join(tmpdir(), DIRECTORY_PREFIX));
    const path = join(directory, `page.${extension}`);
    await writeFile(path, text, { encoding: "utf8", mode: 0o600 });
    return { ok: true, path };
  } catch (error) {
    // A failed write can leave a partial page. Preserve the write error if cleanup fails.
    if (directory) await rm(directory, { recursive: true, force: true }).catch(() => {});
    const reason = error instanceof Error ? error.message : String(error);
    return { ok: false, reason: cleanText(redactSecrets(reason), 200) ?? "unknown error" };
  }
}

/** Remove a page that was saved for an answer that then could not be given. */
export async function discardSavedPage(saved: SavedPage): Promise<void> {
  if (!saved.ok) return;
  const directory = dirname(saved.path);
  // Callers pass only results from savePage; guard against deleting an unrelated path.
  if (
    !basename(directory).startsWith(DIRECTORY_PREFIX) ||
    !basename(saved.path).startsWith("page.")
  )
    return;
  await rm(directory, { recursive: true, force: true });
}

const count = (chars: number) => chars.toLocaleString("en-US");

/** Footer naming the saved page, or saying why there is none. */
export function savedPageNote(
  saved: SavedPage,
  chars: number,
  next = "Read the rest with your file tools.",
): string {
  return saved.ok
    ? `\n\n[Full page saved to: ${saved.path} (${count(chars)} characters). ${next}]`
    : `\n\n[The full page (${count(chars)} characters) could not be saved: ${saved.reason}. Only the beginning is shown.]`;
}

/** Error whose message points to Google's unconverted copy, saved for searching. */
export async function withSavedCopy(error: unknown): Promise<unknown> {
  const copy = (error as { unconvertedCopy?: string } | undefined)?.unconvertedCopy;
  if (!(error instanceof Error) || !copy) return error;
  const saved = await savePage(copy, "html");
  const where = saved.ok
    ? `was saved to: ${saved.path}. Search it with your file tools.`
    : `could not be saved: ${saved.reason}.`;
  return new Error(
    `${error.message} Google's unconverted HTML (${count(copy.length)} characters) ${where}`,
  );
}
