# Upstream implementation brief: dynamic Antigravity model discovery

## Goal

Make the Antigravity backend catalog the source of truth for Pi's selectable model list, so newly launched models can appear without a catalog-only extension release.

This branch is intentionally based on upstream `Rahularya01/pi-antigravity@855c5fce` (0.6.0), not on the fork's merged implementation. Implement the change cleanly against upstream.

## Confirmed behavior

A live test using the existing Pi Antigravity OAuth flow successfully returned the complete `fetchAvailableModels` catalog, including newly available model variants. This means dynamic discovery is viable with the extension's existing OAuth path; do not assume the limited-catalog observation in issue #31 applies universally.

## Scope

Implement:

1. Reuse the existing authenticated `v1internal:fetchAvailableModels` request path.
2. Normalize runtime IDs into public Pi model IDs.
3. Group thinking variants such as `gemini-3.8-flash-low|medium|high` into one public model with correct Pi thinking levels and runtime routing.
4. Wire Pi's native provider `refreshModels` API so the picker can refresh without an extension release.
5. Keep a last-known-good catalog/cache so transient discovery failures do not wipe the usable model list.
6. Preserve explicit legacy aliases/workarounds where backend runtime IDs do not follow the generic grouping rule.
7. Add fixture-based tests for discovery, grouping, cache behavior, and runtime routing.

## Non-goals / constraints

- Do not shell out to `agy` or introduce another agent loop. Pi remains the only harness.
- Do not replace the current OAuth flow solely to solve model discovery.
- Do not hard-code Gemini 3.8 as the mechanism that makes this work. Gemini 3.8 should be an acceptance case proving an unknown model can be discovered dynamically.
- Do not add a new silent cross-generation fallback for discovered models. If a selected runtime model is unavailable, surface that failure rather than silently substituting another generation.
- Keep the PR focused on model discovery. Avoid unrelated refactors.

## Suggested shape

- `src/client/*`: expose a reusable authenticated fetch of the complete available-model catalog.
- `src/models/discovery.ts`: fetch + normalize + group live models.
- `src/models/cache.ts`: last-known-good persistence, replace-on-success only.
- `src/models/models.ts`: retain only conservative seed/legacy metadata and explicit routing overrides; runtime routing should prefer the live catalog.
- `src/index.ts`: register initial cached/static models and wire `refreshModels`.

Verify the exact `refreshModels` types from the current `@earendil-works/pi-*` dependency versions instead of assuming the API shape.

## Acceptance criteria

- With a fixture containing `gemini-3.8-flash-low`, `gemini-3.8-flash-medium`, and `gemini-3.8-flash-high`, Pi exposes one selectable `gemini-3.8-flash` entry with Low/Medium/High reasoning levels.
- The 3.8 public ID is produced by discovery/grouping, not solely by a static catalog entry.
- A single unknown unsuffixed Gemini/Claude/GPT-OSS runtime remains selectable conservatively.
- Existing Claude, GPT-OSS, Gemini 3.1/3.5 aliases and routing continue to work.
- Empty or failed discovery does not erase the last-known-good model catalog.
- Existing OAuth, streaming, usage, diagnostics, image generation and runtime override behavior remain working.
- `bun run check` passes.
- Live validation with the existing Pi Antigravity OAuth shows a newly available model from `fetchAvailableModels` in Pi's model picker without editing the static model list.

## Related

- Upstream issue: Rahularya01/pi-antigravity#31
- Fork prototype/reference: billyham07/pi-antigravity#1

The fork prototype can be consulted for ideas, but do not copy it mechanically: this upstream PR should be smaller, focused, and derived from upstream `main`.
