# 0.12.0 release audit

Previous stable: 0.11.0. Target: 0.12.0 (additive features and a corrected Node minimum).

## Backlog decisions

| PR   | Decision                                                                                                                                                                                                    |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| #99  | Integrate official SHA-pinned setup-node 7.1.0; disable automatic package-manager caching.                                                                                                                  |
| #100 | Defer: bundles Pi 1.x and TypeScript 7 major upgrades and has failing CI. Requires a separate compatibility migration.                                                                                      |
| #101 | Integrate catalog-aware stale-selection and fallback checks, with regression tests.                                                                                                                         |
| #102 | Defer: adds a substantial web retrieval and HTML conversion subsystem, dependencies, and security policy changes. Needs a dedicated complete security review; existing successful CI alone is insufficient. |
| #103 | Defer: pricing changes need independently verified model-specific sources; tests assert constants but do not substantiate rates.                                                                            |
| #104 | Defer: reference-image upload needs bounded file/count limits and validation of the newly imported peer API across supported Pi versions.                                                                   |
| #105 | Integrate opt-in deferred tool exposure and tests.                                                                                                                                                          |
| #108 | Integrate served-model and response-ID recording and SSE regression tests.                                                                                                                                  |
| #110 | Supersede with stronger fix: raise direct Undici minimum to 8.12.3 and override the vulnerable pinned development copy.                                                                                     |
| #111 | Integrate community compatibility badge; this is community reporting, not a maintainer compatibility guarantee.                                                                                             |
| #112 | Defer: malformed settings can be erased; another application's settings are modified; environment overrides can make toggles misleading; automated coverage is missing.                                     |
| #114 | Integrate timeout classification, endpoint transport fallback, and retry identity changes; add recovery and cancellation tests.                                                                             |

Issues #98 and #113 overlap but have distinct fixes: longer silence allowance and retryable timeout messages. #107 gets nonblocking interactive refresh while retaining awaited headless refresh. #106 remains open: enterprise routing needs a verified request contract, entitlement discovery, and regional-account integration tests; changing a hostname alone is insufficient.

## Security

The initial audit found eight Undici advisories, including four high-severity findings, affecting direct 8.11.2 and transitive 8.10.2 copies. Both resolve to 8.12.3. The package declares Node >=22.19.0, matching that dependency.

Image output previously used lexical path containment and could follow a project symlink outside the project. Output now rejects symlink directory components and uses O_NOFOLLOW for the destination. Regression tests protect an external sentinel file. As with pathname-based local filesystem operations, a concurrently malicious process with permission to rename parent directories can still race directory validation; this is not a filesystem sandbox against another local process.

Tracked-file and Git-history pattern scans found no private-key, GitHub-token, AWS-access-key, or npm-token patterns. These scans are heuristic, not proof that no credential ever existed. OAuth client identifiers and public installed-app client configuration are not user access tokens.

OAuth uses PKCE, random state, and a loopback callback. API base URLs require HTTPS and Google API hosts. Diagnostics redact recognized token formats. Dependency lifecycle scripts remain disabled, the registry is npmjs.org, hardened resolution and checksums remain enabled, workflow actions are SHA-pinned, checkout does not persist credentials, and publishing requests provenance. No broad repository permission changes were made.

Remaining audit findings are development/peer-tree moderate items: minimatch 10.2.6 glob amplification and deprecation warnings for @smithy/core 3.35.0 (custom-logger redaction) and node-domexception. They are not shipped as direct runtime dependencies. Host Pi dependencies remain the host's responsibility; the project's Yarn resolution does not override consumers' dependency trees. No known high or critical findings remain in the locked tree after the fix.

## Validation and packaging

The repository is an ESM Pi extension distributed as TypeScript source, loaded by Pi; it does not promise standalone CommonJS loading or a compiled JavaScript build. TypeScript source carries the exported types.

Run yarn check for typechecking, lint, formatting, security assertions, all regression scripts, production recursive audit, and high-severity recursive full-tree audit. Additional recovery tests exercise endpoint fallback, fresh retry identity, transport error preservation, and cancellation. Startup tests verify interactive completion before discovery and awaited headless completion.

Inspect npm pack --dry-run and test the extracted tarball with the repository test harness. The tarball allowlist contains package.json, LICENSE, README.md, tsconfig.json, and src only; scripts, fixtures, workflow files, credentials, and local configuration are excluded. Running the native Node type-strip harness directly under node_modules fails because Node prohibits stripping dependency TypeScript; test the extracted artifact outside node_modules and separately verify Pi's actual extension loader.

Live authenticated generation and enterprise regional behavior require account access and are not covered by mocked tests. No claim of live backend performance testing is made.

## Executed validation results

- `yarn check`: passed after integration (typecheck, lint, formatting, security assertions, all 17 test scripts, both audit gates).
- Node 22.19.0: routing, startup, and recovery tests passed. Node 24: recovery test passed. CI runs the full suite on all three supported release lines.
- Extracted 0.12.0 tarball: all 17 test scripts passed against freshly installed current peer dependencies (Pi 1.5.0). This exposed and fixed removal of Pi's TypeBox re-exports; TypeBox is now a direct runtime dependency.
- Fresh consumer `npm audit --omit=dev`: zero vulnerabilities reported before the TypeBox addition; repeat as part of final verification.
- CodeRabbit initial integration review: completed with zero findings. Later symlink hardening and compatibility edits were manually reviewed and regression tested.
- Secret-pattern scan: zero matching tracked files and zero matching history commits for the tested patterns.
- `npm pack --dry-run`: inspected allowlisted contents. Node native stripping under node_modules failed as documented above; extracted artifact tests subsequently passed.
- Offline actual Pi invocation with all three installed extension resources exited successfully with no extension-load error; no models are listed without credentials. Live generation remains untested.
