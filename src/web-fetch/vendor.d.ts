// These packages ship no usable declarations for their public module names.
declare module "@mixmark-io/domino" {
  export function createDocument(html: string): Document;
}

declare module "turndown-plugin-gfm" {
  import type TurndownService from "turndown";
  export const tables: TurndownService.Plugin;
}
