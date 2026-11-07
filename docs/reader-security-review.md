# Reader security review guide

A map for reviewing `read_url_content`. Behavior guarantees and their regression checks are in [reader-guarantees.md](reader-guarantees.md). This page covers what to inspect and why the surface is small.

## Trust boundary

- The extension never contacts the page's origin. Every request goes to the same Antigravity endpoints the provider already uses, with the user's existing OAuth token. Google's crawler fetches the page.
- Page content is untrusted text. It is converted to Markdown and returned. No scripts run, no files are downloaded, and nothing in a page is executed or evaluated.
- The tool only reads. It writes one file: the saved full page, in a private temp directory (`save.ts`, mode `0600`).

## Runtime dependencies added

| Package               | Version | License      | Install scripts | Role                                                       |
| --------------------- | ------- | ------------ | --------------- | ---------------------------------------------------------- |
| `turndown`            | 7.2.4   | MIT          | none            | HTML to Markdown                                           |
| `turndown-plugin-gfm` | 1.0.2   | MIT          | none            | Tables and strikethrough                                   |
| `@mixmark-io/domino`  | 2.2.0   | BSD-2-Clause | none            | DOM for turndown (its only dependency); never runs scripts |

`@types/turndown` is a development dependency. `.yarnrc.yml` already disables install scripts, enforces checksums, and applies a package age gate. `yarn audit` and `yarn security-check` report nothing.

## Where to look

| Concern                   | Code                                               | Notes                                                                                                                                              |
| ------------------------- | -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Caller URL policy         | `src/utils/address.ts` (`checkPublicUrl`)          | HTTP(S) only. Rejects credentials, local hosts, private and non-routable addresses, and URLs over 2,048 characters. Search uses the same function. |
| Redirects                 | `resolveRedirect` in `src/web-fetch/web-fetch.ts`  | Destinations reported by Google go through the same policy. Unsafe ones fail closed. Redirects are not followed locally.                           |
| Resource bounds           | `src/web-fetch/limits.ts`, `document.ts`           | 10 s shared deadline, 10 requests, 5 MB response stream, 2 M characters of HTML, 50,000 tokens, 128 nesting depth, 60,000 output characters.       |
| HTML conversion           | `src/web-fetch/document.ts`, `markdown.ts`         | Size, token, and depth limits apply before parsing. The DOM is built with domino, which has no script execution.                                   |
| Secret redaction          | `src/utils/security.ts`                            | Applied to URLs, progress, metadata, errors, and page echoes of the requested URL. Arbitrary secrets in page text are not filtered.                |
| Output file               | `src/web-fetch/save.ts`                            | `mkdtemp` directory and a `0600` file. A failed save is reported and the page is kept in the answer.                                               |
| Tool and command exposure | `src/features/read-url-content.ts`, `src/index.ts` | Disable with `ANTIGRAVITY_NO_FETCH_TOOL`, `ANTIGRAVITY_NO_EXTRA_TOOLS`, or `pi config`.                                                            |

## Known limits

- Intermediate redirects and DNS resolution happen at Google, so only the final reported destination can be checked here.
- Markdown output is page-controlled text. A consuming model should treat it as untrusted, as it does any fetched page.
- Pages beyond the conversion limits are refused. Google's unconverted HTML is saved.

## Reviewing

```sh
yarn check            # types, lint, format, tests, audit
yarn security-check
```

Offline regression suites: `scripts/test-web-fetch.ts`, `scripts/test-reader-foundations.ts`. After `/login antigravity`, `yarn smoke:fetch` runs the live check.
