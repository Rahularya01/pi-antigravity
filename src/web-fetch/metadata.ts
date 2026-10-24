/** Page-controlled field limits, shared by extraction and display. */
export const METADATA_LIMITS = {
  title: 300,
  description: 1_000,
  updated: 100,
  author: 300,
  published: 100,
  language: 50,
} as const;
