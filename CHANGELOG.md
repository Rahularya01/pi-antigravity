# Changelog

All notable changes to this project are documented in this file.

## [Unreleased]

### Added

- **Gemini 4 Hydrogen & Oxygen support:** Added dynamic discovery allowlist for selectable Hydrogen and Oxygen variants beyond `agentModelSorts` (#134), `xhigh` thinking level grouping (`-xhigh`, `(XHigh)`, `(X-High)`), fallback routing, list pricing ($1.50/M input, $7.50/M output, $0.075/M cache read), 262,144 output token limit, and `-xhigh` sibling capacity fallback (#132, #133, #136).

### Changed

- **Development dependencies & security:** Updated `@earendil-works/pi-ai` and `@earendil-works/pi-coding-agent` to `^1.5.0` (#128) and resolved `minimatch` to `11.0.3` to remediate GHSA-g3hv-75wg-m249 (`<11.0.1`).

### Fixed

- **Disabled model filtering:** Exclude backend entries flagged `disabled: true` or suffixed `-disabled` from model discovery even when listed in `agentModelSorts` (#132, #136).
- **Cross-provider tool observation mimicry:** Keep unsigned tool-call turn boundaries separated, track degraded observations accurately without false triggers on quoted markers, handle reused/colliding tool call IDs, and append a recency history note (#118).
- **Pi 1.5.x compatibility:** Import `Type` from `typebox` in `read_url_content` instead of `@earendil-works/pi-ai` and narrow `ProviderModelConfig` types for text models.

## [0.13.0] - 2026-11-12

### Added

- **Gemini Enterprise routing:** `ANTIGRAVITY_LOCATION=eu|us` (or `ANTIGRAVITY_ENTERPRISE=1`) sends inference only to the documented Business AI Code host for that location. Consumer `cloudcode-pa` fallback is not used, so a regional license is not retried on the endpoint that returns error #3501. Image prompts and reference images are not uploaded while enterprise routing is active. Requires `ANTIGRAVITY_ENTERPRISE_PROJECT` and `ANTIGRAVITY_USER_TIER` (#106).
- **`read_url_content` tool:** Reads public pages through Google's Antigravity fetch service and converts HTML to Markdown. Inadequate cached copies retry live, with useful cached content retained on recovery failure. The tool inspects metadata and article-matched JSON-LD before cleanup, and can recover through one advertised same-origin Markdown or supported article-JSON representation. Results distinguish source completeness, suspected content problems, and output truncation, and report retrieval attempts and provenance. Pages too long for one answer are saved whole to a private temp file named in the answer. `/antigravity.fetch [--raw] <url>` exposes interactive fetching; raw mode preserves the crawled source. Disable with `ANTIGRAVITY_NO_FETCH_TOOL=1`, `ANTIGRAVITY_NO_EXTRA_TOOLS=1`, or the `read-url-content` resource in `pi config` (#102).
- **Google One credit overages:** `/antigravity.credits` checks the reported balance and toggles `enabledCreditTypes: ["GOOGLE_ONE_AI"]`. Overages stay off unless enabled by `ANTIGRAVITY_USE_CREDITS`, Pi settings, or the official CLI settings (#112).
- **Reference images:** `generate_image` accepts up to four project-relative PNG, JPEG, WebP, or GIF references, 10 MB each. Paths must stay inside the working directory after `realpath` (#104).

### Changed

- **Client fingerprint:** Default User-Agent is `antigravity/cli/1.5.5`, matching the current official `agy` CLI.
- **Model prices:** Each Gemini and Claude model uses its own published per-million-token rate instead of one shared Flash or Pro placeholder (#103).

### Fixed

- Declare `typebox` as a `"*"` peer dependency instead of a runtime dependency, as Pi requires for host-provided packages. This clears Pi's "Host-provided extension packages must be declared in peerDependencies" extension warning and avoids installing a duplicate TypeBox copy (#116, #119).
- **Thinking-off and capacity 429s:** A generic `RESOURCE_EXHAUSTED` response now tries the other endpoints and one same-generation sibling tier, so `gemini-3.8-flash` with reasoning off is not stuck on a dead `-low` runtime and `gemini-4-argon-high` can step down while quota remains (#125, #122). Hard quota walls with a reset time are unchanged.
- **`before_provider_request`:** `streamAntigravity` applies `onPayload` to the final request body before it is sent (#126).
- **Staggered model rollouts:** Merging `fetchAvailableModels` across endpoints now unions the curated `agentModelSorts` recommendation lists instead of letting the last endpoint overwrite them. Models that launch on the daily/sandbox endpoints before production (e.g. Gemini 4 Carbon) stay selectable after `/antigravity.refresh` (#123).
- **Reader recovery and reporting:** One shared ten-second deadline and a ten-request ceiling bound Google retrieval. Useful cache content survives failed live recovery. Source completeness, heuristic content assessment, publisher metadata, omitted sections, and output truncation are reported separately. Failed and degraded reads leave sanitized diagnostics.
- **Page conversion:** HTML conversion has size, depth, and element limits. Independent blocks avoid repeated prefix scans. Content-root selection skips empty placeholders, status reference articles are not mistaken for access walls from their headings alone, and XML/SVG documents remain intact. Unicode repair preserves body structure. Class names such as `has-sidebar`, `menu-open`, or `lg:grid-cols-sidebar-content` no longer remove a wrapper that holds the article, tag names the DOM cannot clone no longer fail a read, relative links honor `<base href>`, and a cut-off copy holding only its title is reported as empty.
- **URL and credential safety:** Reader and search share a conservative public-URL policy. Explicit unsafe redirects fail closed. Recognized credentials are redacted from rendered URLs, progress, metadata, and errors without corrupting ordinary diagnostics or JSON. Credential parse failures do not quote their input.
- **Output:** Provenance and the saved-page footer count toward the complete output cap. Consumers own footer space. A budget too small to answer leaves no saved file, and a failed save is reported without losing the page.
- **MDN article recovery:** Inadequate page copies can use same-origin, identity-matched article JSON. Supported prose and specification sections survive unknown section types, with omissions noted. Incomplete article data is never reconstructed. Cut-off or unavailable Wikipedia articles and raw GitHub files recover through identity-checked publisher copies. Raw mode returns the crawled source whatever its size.

## [0.12.0] - 2026-11-06

### Security

- Require Undici 8.12.3 and pin the development dependency tree to the patched version.
- Compare parsed hosts in search title enrichment and escape Markdown link-label backslashes.
- Reject image output paths through symlinks and open output files without following symlinks.
- Raise the minimum Node.js version to 22.19.0 to match Undici's supported runtime.

### Fixed

- Import schemas from a direct TypeBox dependency so both older supported Pi and current Pi releases load the tools.
- Respect the refreshed catalog for stale selections and compatibility fallbacks (#101).
- Refresh models in the background for interactive startup; preserve awaited headless refresh (#107).
- Mark header and stream-stall timeouts retryable, try alternate endpoints after transport errors, and use fresh upstream identities on retries (#114, #113).
- Increase the default stream silence timeout to five minutes and document both timeout controls (#98).

### Added

- Optional deferred tool exposure on compatible Pi versions (#105).
- Oh My Pi community compatibility badge (#111).
- CI coverage for Node 22.19.0, 24, and 26; updated pinned setup-node action (#99).

### Added

- **Served model tracking:** Assistant messages record the backend `modelVersion` as `responseModel` and the backend `responseId`, so session files show which model actually served a request when it differs from the requested runtime model.

## [0.11.0] - 2026-10-16

### Added

- **Per-claim search citations:** Google Search results follow grounding redirects and page titles, then cite each claim with a real label and URL. Enrichment is bounded, skips private and non-HTTP destinations, and can be disabled with `ANTIGRAVITY_NO_SOURCE_ENRICH=1` (#86).

### Changed

- **Live catalogs:** A successful discovery replaces the selectable catalog with advertised models, capabilities, and token limits instead of re-inserting missing static entries. Lookup is exact. Older caches and account changes refresh on the next network-enabled run (#90, #92, #93).
- **Client fingerprint:** Default User-Agent is aligned with official CLI `1.4.0` (`antigravity/cli/1.4.0`), ensuring capability gating exposes Gemini 4 Argon and newest agent routes (#93, #94, #95, #96, #97).
- **Active model curation:** Prioritize Google's curated `agentModelSorts` during model discovery and `/antigravity.models`, matching official `agy` CLI behavior and filtering out deprecated/retired routes like `gemini-pro-agent` and historical 2.5/3.1 Pro models that fail or loop in retries (#89, #97).

### Fixed

- **Default Google Search:** Lite searches no longer send `thinkingBudget: 0`, which the backend rejects with HTTP 400. Model-specific invalid-argument responses try the remaining search fallbacks (#84, #85, #88).
- **Unavailable models:** A generic 429 `RESOURCE_EXHAUSTED` without a reset hint fails immediately, keeps the backend message, and suggests a Flash model instead of looking like a quota wall that Pi retries (#89).
- **Headless catalogs:** Session start refreshes the persisted catalog outside the interactive picker, so a later `pi -p` run can resolve newly entitled models (#93).
- **Static diagnostics:** Requests that skip dynamic discovery still record the matched runtime and known catalog instead of `matched=none, available=unknown` (#89).

## [0.10.0] - 2026-10-08

### Added

- **Native image API:** Pi `generateImages` / codemode can call `gemini-3.1-flash-image` without saving files (#82).
- **Per-feature toggles:** `pi config` can disable `src/features/google-search.ts` or `src/features/generate-image.ts` while keeping the provider and slash commands. Environment variables still force a loaded tool off (#79).

### Changed

- **Google Search default:** Interactive search uses `gemini-3.5-flash-lite` with a compact evidence brief and no default thinking budget. `--thinking` and `--model` still override it. Fallbacks are `gemini-3.1-flash-lite` and `gemini-3-flash` (#80).
- **Image requests:** Default image model is `gemini-3.1-flash-image`, using the direct image endpoint and `image_gen` request type, with the legacy stream endpoint only on HTTP 404 (#81).

### Fixed

- **Subscription marker:** The OAuth registration now sets `isSubscription`, so Pi classifies Antigravity models as subscription-backed (footer `(sub)` marker) instead of metered (#74).
- **Search citations:** Inline Google Search citations use UTF-8 byte offsets and keep original source indexes (#78).
- **Session IDs:** Explicit and fallback session IDs are stable signed-int64 values instead of a new random ID on every omitted-ID request (#76, #77).
- **Mid-stream errors:** A trailing 500/503 body, or a stream that ends without `finishReason`, is reported as an error instead of a successful stop (#72).
- **Account verification:** A 403 `VALIDATION_REQUIRED` response includes the `accounts.google.com` verification link. `/antigravity.doctor` still redacts that link (#73).

## [0.9.0] - 2026-09-30

### Added

- **Extra tool toggles:** `ANTIGRAVITY_NO_EXTRA_TOOLS`, `ANTIGRAVITY_NO_SEARCH_TOOL`, and `ANTIGRAVITY_NO_IMAGE_TOOL` stop the `google_search` / `generate_image` tools from being registered so they do not clash with other search providers (#65).

### Changed

- **Dependencies:** Bump undici to 8.11.2 and dev tooling to pi 0.86.1, which clears the high-severity undici advisories (GHSA-rfgv-xxqx-mfg5, GHSA-w293-vg96-wgc3) reported by `yarn audit`.

### Fixed

- **Emoji corruption:** `sanitizeText` now only replaces unpaired surrogates, so valid emoji and other astral characters are no longer turned into U+FFFD (#66, #67, thanks @sobh).
- **OAuth response decompression:** Use the existing Undici fetch for Google OAuth requests so SDK hosts do not parse raw gzip bytes as JSON with Node 26 built-in fetch (#69, thanks @Nyarlathoteppppp).

## [0.8.1] - 2026-09-28

### Added

- **Google Search grounding:** `google_search` and `/antigravity.search` run an isolated Cloud Code Assist search request through the signed-in session (#62).

### Fixed

- **Oh My Pi install:** Load `registerApiProvider` from a namespace import so `omp plugin install npm:pi-antigravity` does not fail when the bundled Pi runtime omits that export (#61).
- **Wire fingerprint:** Match Antigravity CLI 1.2.4 user-agent labels and keep multi-turn `last_execution_id` off the first step, with separate trajectory ids per session (#63).

## [0.8.0] - 2026-09-20

### Added

- **Linked Google accounts:** `/login antigravity` keeps previous accounts in `~/.pi/agent/antigravity-accounts.json`. `/antigravity.accounts` lists, switches, and removes them. A hard quota wall automatically fails over to the next linked account (#47, #58).

### Changed

- **Yarn 4 toolchain:** Development, CI, and publish use Corepack-pinned Yarn 4 instead of Bun. Installs run with lifecycle scripts disabled, lockfile checksum verification, a 3-day npm publish age gate, and `yarn npm audit`. Releases publish with npm provenance.

### Fixed

- **Pi 0.86 tools and system prompt:** Read prompt and tool declarations from normalized transcript system messages (`getCurrentSystemPrompt` / `getCurrentTools`, with a local replay fallback) so requests are not sent without tools (#51, #52, #53, #54, #55, #57).
- **Startup freeze:** TLS pre-warm runs on the first Antigravity request instead of at extension load, so Pi startup is not blocked for ~10s on Node 24 (#50).

## [0.7.1] - 2026-09-03

### Added

- **Dynamic model discovery:** Refresh the selectable catalog from authenticated `fetchAvailableModels`, group runtime thinking variants into public Pi model IDs, and retain a last-known-good cache with conservative static fallback models.

### Fixed

- **Tool schema references:** Resolve local JSON Schema `$ref` pointers, including nested, escaped, repeated, cyclic, and array-index references, while isolating invalid tool declarations and reporting diagnostics.
- **Gemini reasoning:** Respect reasoning-off selections for dynamically discovered Gemini models.

## [0.7.0] - 2026-09-02

### Added

- **Gemini 3.8 Flash:** Added public model `gemini-3.8-flash` with Low, Medium, and High thinking-effort routing to `gemini-3.8-flash-low|medium|high`. Falls back to Gemini 3.7 Flash if the runtime is not yet advertised on an endpoint.

## [0.6.0] - 2026-09-02

### Added

- **Live cost tracking:** Model catalog now includes standard API-equivalent rates, and streams report calculated usage cost so Pi's statusline is no longer stuck at `$0.00` (#30).
- **Image generation:** `/antigravity.image` and the `generate_image` tool create images through Cloud Code Assist using the signed-in Antigravity account (#21).

### Changed

- **System prompt:** When Pi provides `context.systemPrompt`, it is sent as `systemInstruction` without the hardcoded Antigravity persona prefix (#27).

## [0.5.2] - 2026-08-30

### Fixed

- **Node Pi CLI:** The extension no longer uses `Bun.*` APIs at load time. `pi` (Node) can load it again; OAuth, hashing, env, and HTTP go through Node/`fetch`/`undici`.

## [0.5.1] - 2026-08-30

### Fixed

- **CI / publish:** Install Bun from the official script instead of `oven-sh/setup-bun`, which this repository's GitHub Actions allowlist rejects.

## [0.5.0] - 2026-08-30

### Changed

- **Bun runtime:** The extension is Bun-only. OAuth uses `Bun.serve`, hashing uses `Bun.CryptoHasher`, HTTP uses Bun's `fetch` pool (no `undici`), and the toolchain is Bun. This works when Pi itself is running on Bun (the compiled `pi` binary). The npm-installed Node `pi` CLI will not load Bun APIs.
- **Antigravity request shape:** Gemini 3.6/3.7 Flash use per-effort runtime IDs and `thinkingLevel`; 3.5 Flash and 3.1 Pro send `thinkingBudget`. Requests use the `antigravity/hub` user-agent, `daily-cloudcode-pa` first, default `VALIDATED` tool mode, and the `agent/<id>/<ts>/<trajectory>/<step>` request envelope.

### Fixed

- **Cross-provider tool history:** Unsigned Gemini 3+ function calls from other providers are replayed as text observations instead of triggering a `thought_signature` 400 (#22).
- **Error stops:** Stream errors now keep the provider `finishReason` and skip aborted/errored assistant turns on replay (#23).
- **Foreign thinking:** Thinking blocks from other models are dropped from Gemini history so they are not copied into the visible answer (#24).
- **Tool images:** Image blocks on `toolResult` messages are sent as `inlineData` (#25).
- **Prompt cache:** Fallback tool-call IDs no longer include `Date.now()`, so history stays byte-stable across turns (#26).
- **Compat registry:** Register `antigravity-api` with `@earendil-works/pi-ai/compat` so plugins like `pi-condense` can stream Antigravity models (#29).

## [0.4.1] - 2026-08-22

### Fixed

- **Proxy-aware requests:** When `HTTP_PROXY`, `HTTPS_PROXY`, or `ALL_PROXY` is set, skip the private keep-alive dispatcher so requests use Pi's proxy-aware global dispatcher instead of connecting around the proxy (#20).
- **Command display:** `/antigravity.usage`, `/antigravity.models`, and `/antigravity.doctor` no longer `console.log` into the interactive TUI (which overwrote the editor and status chrome). Reports go through Pi's chat `notify` in interactive mode and stdout only in headless mode (#19).

## [0.4.0] - 2026-08-22

### Performance

- **Keep-alive connection pool:** Provider requests now go through a long-lived `undici` dispatcher (60s idle keep-alive, 5 min max) so consecutive turns reuse one socket. Node's built-in fetch drops an idle socket after 4 seconds unless the server advertises a longer `Keep-Alive: timeout=`, and the Cloud Code Assist endpoint sends no such header, so every turn previously paid a fresh DNS + TCP + TLS handshake. Measured against the production endpoint with a 6 second gap between turns, median request-initiation time dropped from 97 ms to 30 ms. The dispatcher is scoped to this provider's own requests rather than installed globally, so it does not change HTTP behaviour for the rest of the host process. Disable with `ANTIGRAVITY_NO_KEEPALIVE=1`; opt into HTTP/2 with `ANTIGRAVITY_HTTP2=1`.
- **Connection pre-warm:** The TLS connection to the primary endpoint is opened when the extension loads, so the first message of a session skips the handshake as well. Disable with `ANTIGRAVITY_NO_PREWARM=1`.
- **Smaller request prefill:** Removed a duplicated copy of the Antigravity system instruction that was sent inside an `[ignore]` wrapper on every request, trimming 228 characters from every request body.

### Changed

- **SSE read buffer:** The streaming reader now advances a read offset and compacts its buffer once per network chunk instead of re-slicing it for every parsed line. This is a readability change, not a performance one: V8 represents the old `slice` as a sliced string rather than a copy, and benchmarking the two loops over a 1.6 MB response showed no meaningful difference.

### Tests

- Added `scripts/test-stream-sse.ts`, which replays a fixed SSE body at nine different chunk sizes (down to 1 byte) and asserts the parsed text, thinking, tool calls, usage, and emitted event sequence are identical for every chunk boundary.

## [0.3.1] - 2026-08-19

### Performance

- **Fast Time-to-First-Token (TTFT):** Bypassed pre-flight model discovery round-trips for known static models (`gemini-3.7-flash`, `claude-sonnet-4-6`, etc.), immediately sending streaming requests with verified runtime IDs and falling back to dynamic lookup only when needed.
- **Fast-path endpoint discovery:** Updated model discovery to prioritize the primary production endpoint and return immediately upon match, eliminating latency stalls from slower sandbox endpoints.
- **Parallelized usage & quota fetch:** `fetchAccountUsage()` now runs `loadCodeAssist`, `retrieveUserQuotaSummary`, and `fetchMergedAvailableModels` concurrently in a single `Promise.all()`, roughly halving `/antigravity.usage` execution time.

### Fixed

- **Turn alternation & message merge:** Automatically merge consecutive same-role messages (`user` or `model`) and guarantee initial user turn in `convertMessages()`, preventing 400 Bad Request multi-turn errors from Google Cloud Code Assist.
- **Base64 image Data URLs:** Sanitize image data by stripping `data:...;base64,` prefixes and auto-detecting MIME types in `asTextParts()` to prevent image payload rejection by Gemini.
- **Tool schema `$ref` dereferencing:** Inlined local `$defs` / `definitions` in tool schemas before meta keyword stripping, preventing dangling `$ref` schema errors on complex custom tools.
- **OAuth server socket cleanup:** Added friendly `EADDRINUSE` messaging for port 51121 and called `server.closeAllConnections()` for immediate socket teardown upon sign-in completion.

### Diagnostics

- **Latency & Doctor enhancements:** Added `lastLatencyMs` to `/antigravity.doctor` and introduced a safe `maskEmail` utility.

## [0.3.0] - 2026-08-16

### Performance

- **Parallelized model discovery:** `fetchAvailableRuntimeModel` probed 2 endpoints × 3 request-body variants sequentially (up to 6 awaited round-trips) on every cache miss before a generation request could even start. Fired concurrently instead, and removed two variants that were provably dead weight — one always returned a 400 (`cloudaicompanionProject` isn't a real field on this endpoint) and one was byte-identical to another. Measured against the live backend: cold model discovery down from ~3.6s to ~1.4s (2.5x), and the full cold-start setup path (token refresh + discovery) down from ~5.8s to ~1.1s (5.2x).
- **Skip redundant project discovery on token refresh:** `refreshAntigravityToken` always called `loadCodeAssist` even though its cache is keyed by token and a refresh always mints a new one, guaranteeing a wasted round-trip. Now skipped whenever the credentials already carry a `projectId` (the normal case).
- **Longer caches:** model-discovery and project-id caches extended from 10/5 minutes to 30 minutes, so the (now much cheaper) cold path is hit a third as often.
- **Parallelized `/antigravity.usage` and `/antigravity.models`:** merged model-catalog fetch across endpoints concurrently instead of sequentially, and dropped the same dead request-body variant.

## [0.2.10] - 2026-08-15

### Documentation

- **README & Security Polish:** Reorganized documentation with a table of contents, clear onboarding structure, detailed breakdown of required OAuth scopes in a reference table, and updated security policy.

## [0.2.9] - 2026-08-15

### Fixed

- **Gemini 3.7 Flash runtime routing:** Route every displayed effort through the live `gemini-3.7-flash-tiered` runtime and send Low, Medium, or High via `generationConfig.thinkingConfig`. Add the `aicode` OAuth scope used by the current Antigravity CLI so future logins receive the complete model catalog.

## [0.2.8] - 2026-08-14

### Added

- **Gemini 3.7 Flash Support:** Added public model `gemini-3.7-flash` with Low, Medium, and High thinking-effort routing to `gemini-3.7-flash-low|medium|high` and 65,536 output token budget.
- **Graceful Runtime Fallback:** Added automatic runtime candidate fallback (e.g. falling back to Gemini 3.6 Flash when 3.7 Flash is requested before backend deployment/activation) to prevent 404 stream rejections during server-side model rollouts.

## [0.2.7] - 2026-08-14

### Added

- **Gemini 3.7 Flash Support:** Added public model `gemini-3.7-flash` with Low, Medium, and High thinking-effort routing to `gemini-3.7-flash-low|medium|high` and 65,536 output token budget.

## [0.2.6] - 2026-08-04

### Fixed

- **Claude/GPT tool schema 400s:** Normalize custom-tool bridge schemas with an allowlist (`type`, `description`, `properties`, `required`, `items`, `enum`) instead of a denylist, so keywords like `nullable` and JSON Schema type unions (`["string","null"]`) no longer trigger `Unknown name` / Invalid JSON payload rejections from Cloud Code Assist.
- **Request-format error diagnostics:** Include the backend rejection message in friendly 400 errors so the unknown field is visible without digging through raw API responses.

## [0.2.5] - 2026-07-27

### Fixed

- **Maximum Output Token Limit (#6):** Default `maxOutputTokens` request budget now uses the model's full verified maximum output capacity instead of an arbitrary 8192-token fallback limit, preventing premature completion cut-offs on long responses. Added request-side token clamping matching exact backend per-runtime limits (65,536 for Gemini 3.6/3.5 Flash, 65,535 for Gemini 3.1 Pro, 64,000 for Claude Opus/Sonnet, 32,768 for GPT-OSS 120B) to prevent 400 Bad Request errors when caller options exceed model ceilings.
- **Thinking Model Accessibility & Routing (#7):** Added unit regression tests ensuring all public model IDs and thinking levels expose backend-supported routing and hiding unavailable levels. Recorded live model map keys and display labels across all advertised efforts.

## [0.2.4] - 2026-07-23

### Performance

- Skip redundant `loadCodeAssist` HTTP call per inference when credentials already carry a project ID.
- Cache `fetchAvailableRuntimeModel` results for 10 minutes, eliminating 2–6 repeated HTTP calls on every stream request.
- Rewrite SSE stream parser to use index-based scanning instead of `split('\n')`, removing per-chunk array allocations.
- Consolidate `loadCodeAssist` in `/antigravity.usage`: reuse a single response for both project ID resolution and tier info, and run quota summary fetch in parallel.
- Replace O(n) `projectCache` eviction with O(1) LRU (insertion-order delete).

## [0.2.3] - 2026-07-23

### Fixed

- Show only the thinking levels supported by each Antigravity model instead of every Pi level.

## [0.2.2] - 2026-07-21

### Added

- Gemini 3.6 Flash (`gemini-3.6-flash`) with Low/Medium/High thinking-effort routing to `gemini-3.6-flash-low|medium|high`.

### Changed

- Runtime model discovery keeps searching endpoint candidates so daily/sandbox-only models (currently 3.6 Flash) resolve correctly.

## [0.2.0] - 2026-07-21

### Added

- Isolated per-request diagnostics and the `/antigravity.doctor` command for sanitized provider troubleshooting.
- Coverage for model routing, tool-schema normalization, stable project IDs, and Claude tool-call conversion.

### Changed

- Split the provider into focused auth, client, diagnostics, models, streaming, types, usage, and utility modules.
- Made project-ID fallback stable per authenticated account instead of depending on the local working directory.
- Clarified OAuth client behavior and how to use a custom Google Cloud OAuth client.
- Bumped the package version to 0.2.0.

### Security

- Centralized API endpoint validation, callback loopback enforcement, and diagnostic secret redaction.
