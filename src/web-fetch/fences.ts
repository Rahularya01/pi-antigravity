/** CommonMark fenced blocks, including blockquote containers. */
export const FENCE_LINE = /^ {0,3}((?:>\s*)*)(`{3,}|~{3,})(.*)$/;
export type Fence = { marker: string; length: number; prefix: string };

export function advanceFence(open: Fence | undefined, line: string): Fence | undefined {
  const match = FENCE_LINE.exec(line);
  if (!match) return open;
  const [, prefix, delimiter, rest] = match;
  if (!open) {
    if (delimiter[0] === "`" && rest.includes("`")) return undefined;
    return { marker: delimiter[0], length: delimiter.length, prefix };
  }
  return delimiter[0] === open.marker &&
    delimiter.length >= open.length &&
    prefix === open.prefix &&
    !rest.trim()
    ? undefined
    : open;
}
export function unclosedFence(text: string): Fence | undefined {
  let open: Fence | undefined;
  for (const line of text.split("\n")) open = advanceFence(open, line);
  return open;
}
