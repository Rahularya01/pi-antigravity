# Upstream implementation brief: dynamic Antigravity model discovery

## Goal

Make the Antigravity backend catalog the source of truth for Pi's selectable model list, so newly launched models can appear without a catalog-only extension release.

This branch is intentionally based on upstream `Rahularya01/pi-antigravity@855c5fce` (0.6.0), not on the fork's merged implementation. Implement the change cleanly against upstream.

## Confirmed behavior

Dynamic discovery is viable with the extension's existing OAuth path: `fetchAvailableModels` is the source of truth for whatever the current account/auth tier actually returns. Some accounts, including free-tier, may omit newer families such as Gemini 3.8. That is an auth-catalog difference (see issue #31), not a discovery-implementation failure, and it is not universal.

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
- Do not hard-code Gemini 3.8 as the mechanism that makes this work. Fixture grouping of an unknown `*-low|medium|high` family (3.8 in tests) is the required acceptance case. Live 3.8 is only a conditional validation when the current account/auth tier exposes it; free-tier catalogs without 3.8 do not fail this PR.
- Do not add a new silent cross-generation fallback for discovered models. Existing static Gemini rollout remaps stay as-is.
- Keep the PR focused on model discovery. Avoid unrelated refactors.

## Suggested shape

- `src/client/*`: expose a reusable authenticated fetch of the complete available-model catalog.
- `src/models/discovery.ts`: fetch + normalize + group live models.
- `src/models/cache.ts`: last-known-good persistence, replace-on-success only.
- `src/models/models.ts`: retain only conservative seed/legacy metadata and explicit routing overrides; runtime routing should prefer the live catalog.
- `src/index.ts`: register initial cached/static models and wire `refreshModels`.

Verify the exact `refreshModels` types from the current `@earendil-works/pi-*` dependency versions instead of assuming the API shape.

## Acceptance criteria

- **Required:** with a fixture containing a previously unknown `gemini-3.9-flash-low|medium|high` family, grouping exposes one selectable `gemini-3.9-flash` entry with Low/Medium/High reasoning levels. That public ID is produced by discovery/grouping, not a static catalog entry.
- **Required:** a single unknown unsuffixed Gemini/Claude/GPT-OSS runtime remains selectable conservatively. Explicit `supportsThinking: false` must not grow fake reasoning controls.
- **Required:** existing Claude, GPT-OSS, Gemini 3.1/3.5 aliases and routing continue to work. Existing Gemini rollout remaps are unchanged.
- **Required:** empty or failed discovery does not erase the last-known-good model catalog.
- **Required:** existing OAuth, streaming, usage, diagnostics, image generation and runtime override behavior remain working.
- **Required:** `bun run check` passes.
- **Conditional live validation:** when the current account/auth tier's `fetchAvailableModels` payload includes a newly available family, it should appear in Pi after refresh without editing the static list. Gemini 3.8 is that case only if the catalog exposes it; free-tier accounts that omit 3.8 are not a failure of this PR.

## Implementation notes

- Grouping lives in `src/models/grouping.ts` and must produce an unknown Gemini family from `*-low|medium|high` fixtures without a static catalog entry.
- `refreshModels` is wired in `src/index.ts` from `src/models/discovery.ts`.
- Cache writes are replace-on-success only (`src/models/cache.ts`).
- Existing Gemini rollout fallbacks are unchanged by discovery.
- Live 3.8 is account/tier-dependent. Dynamic discovery of whatever the catalog returns is the required bar.

## Related

- Upstream issue: Rahularya01/pi-antigravity#31
- Fork prototype/reference: billyham07/pi-antigravity#1

The fork prototype can be consulted for ideas, but do not copy it mechanically: this upstream PR should be smaller, focused, and derived from upstream `main`.
