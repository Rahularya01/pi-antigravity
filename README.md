# pi-antigravity

[![npm version](https://img.shields.io/npm/v/pi-antigravity?logo=npm)](https://www.npmjs.com/package/pi-antigravity)
[![license](https://img.shields.io/npm/l/pi-antigravity)](LICENSE)

**pi-antigravity** is a [Pi Coding Agent](https://pi.dev) provider that lets Pi talk directly to Google Antigravity / Cloud Code Assist models — Gemini, plus the Claude and GPT-OSS models Antigravity also advertises. Sign in with Google, pick a model, and go. Under the hood it handles OAuth login, native streaming, model routing, and quota diagnostics itself, so it never shells out to an external Antigravity CLI.

> **Unofficial integration.** This project is not affiliated with or endorsed by Google. Use it only with an account and services you are authorized to access, and review its source before granting OAuth permissions.

## Contents

- [Requirements](#requirements)
- [Install](#install)
- [Quick start](#quick-start)
- [Authentication and credential safety](#authentication-and-credential-safety)
- [Commands](#commands)
- [Models and routing](#models-and-routing)
- [Configuration](#configuration)
- [Troubleshooting](#troubleshooting)
- [Development](#development)

## Requirements

- Pi Coding Agent and Pi AI version **0.80.0 or later**
- A Google account that can use the relevant Cloud Code Assist / Antigravity services
- A browser to complete the Google sign-in. Same-machine is best (the browser hits the local callback automatically); on a remote/headless machine, complete sign-in anywhere and paste the resulting callback URL back into Pi (see [Troubleshooting](#troubleshooting)).

## Install

Install from npm:

```bash
pi install npm:pi-antigravity
```

Or install the latest repository version:

```bash
pi install git:github.com/Rahularya01/pi-antigravity
```

Restart Pi (or run `/reload`) after installation. To update the npm package later, use `pi update npm:pi-antigravity`.

## Quick start

1. Start Pi and run `/login antigravity`.
2. Complete Google sign-in in your browser.
3. Select a model, for example:

   ```text
   /model antigravity/gemini-3.7-flash
   ```

4. Start working. If a request fails, run `/antigravity.doctor` for sanitized diagnostics.

## Authentication and credential safety

The provider uses the OAuth 2.0 Authorization Code flow with PKCE, so credentials are only ever exchanged with Google — never typed into Pi.

1. `/login antigravity` opens Google sign-in and starts a temporary callback listener at `http://localhost:51121/oauth-callback`.
2. After you approve access, Pi exchanges the callback code for tokens and stores the provider credentials in Pi's auth store (normally `~/.pi/agent/auth.json`).
3. Pi refreshes access tokens automatically when they expire — you shouldn't need to sign in again unless a token is revoked.

The callback listener binds only to a loopback host, so it isn't reachable from outside your machine. The auth file it writes to contains sensitive access and refresh tokens: **do not commit it, paste it into issues, or share its contents.**

Signing in requests these Google OAuth scopes:

| Scope                                | Why it's needed                                                           |
| ------------------------------------ | ------------------------------------------------------------------------- |
| `aicode`                             | Access to the Cloud Code Assist / Antigravity model catalog and endpoints |
| `cloud-platform`                     | General Cloud Code Assist API access                                      |
| `userinfo.email`, `userinfo.profile` | Identify the signed-in Google account                                     |
| `cclog`                              | Cloud Code Assist logging/telemetry endpoints used by the API             |
| `experimentsandconfigs`              | Server-side experiment and config flags for the API                       |

Review these permissions before approving access. If your credentials expire or are revoked, just re-run `/login antigravity` to sign in again.

## Commands

| Command                         | Description                                                                                      |
| ------------------------------- | ------------------------------------------------------------------------------------------------ |
| `/login antigravity`            | Sign in to Google and configure the provider.                                                    |
| `/model antigravity/<model-id>` | Choose a registered Antigravity model.                                                           |
| `/antigravity.usage`            | Show the server-reported shared quota groups and reset times.                                    |
| `/antigravity.models`           | List available runtime models, remaining shared-pool quota, and capabilities.                    |
| `/antigravity.models all`       | Include tab/chat models normally hidden from the model list.                                     |
| `/antigravity.doctor`           | Show sanitized provider diagnostics, including the endpoint, status, and resolved runtime model. |

Model availability, entitlement, quota groups, and resets are returned by the service and can differ by account. The quota percentage shown for a model can represent a shared pool, not a private per-model allowance.

## Models and routing

The static model IDs registered by this extension match the Antigravity CLI catalog (`agy models`). Use `/antigravity.models` to see live availability and quota for your account — the table below is a reference for what each public model ID maps to.

`agy models` advertises display entries across Gemini Flash (3.7, 3.6, 3.5), Gemini Pro, Claude Sonnet/Opus Thinking, and GPT-OSS Medium. Pi collapses those into seven public model IDs, each showing only the thinking level(s) that model advertises.

### Why Claude and GPT-OSS appear

Antigravity / Cloud Code Assist exposes a multi-provider catalog. Depending on your account, its Google-authenticated API can advertise Google Gemini models alongside Claude models served through Anthropic Vertex and GPT-OSS served through OpenAI Vertex. This extension intentionally exposes those advertised Claude and GPT-OSS models through the single `antigravity` provider; they are not separate Pi providers and do not use a separate Anthropic or OpenAI login.

The backend's display labels do not always match its runtime IDs. For example, `gemini-3.5-flash-extra-low`, `gemini-3.5-flash-low`, and `gemini-3-flash-agent` can be displayed as Gemini 3.5 Flash Low, Medium, and High. Gemini 3.7 Flash uses the single `gemini-3.7-flash-tiered` runtime and receives Low, Medium, or High through `generationConfig.thinkingConfig`; Gemini 3.6 Flash still uses separate effort-specific runtime IDs.

| Public model ID     | Input       | Thinking levels shown | Max output tokens | Request routing                                                                                  |
| ------------------- | ----------- | --------------------- | ----------------- | ------------------------------------------------------------------------------------------------ |
| `gemini-3.7-flash`  | Text, image | Low, Medium, High     | 65,536            | `gemini-3.7-flash-tiered` + `thinkingLevel` Low/Medium/High                                      |
| `gemini-3.6-flash`  | Text, image | Low, Medium, High     | 65,536            | low → `gemini-3.6-flash-low`; medium → `gemini-3.6-flash-medium`; high → `gemini-3.6-flash-high` |
| `gemini-3.5-flash`  | Text, image | Low, Medium, High     | 65,536            | low → `gemini-3.5-flash-low`; medium → `gemini-3.5-flash-low`; high → `gemini-3-flash-agent`     |
| `gemini-3.1-pro`    | Text, image | Low, High             | 65,535            | low → `gemini-3.1-pro-low`; high → `gemini-pro-agent`                                            |
| `claude-sonnet-4-6` | Text, image | High                  | 64,000            | high → `claude-sonnet-4-6`                                                                       |
| `claude-opus-4-6`   | Text, image | High                  | 64,000            | high → `claude-opus-4-6-thinking`                                                                |
| `gpt-oss-120b`      | Text        | Medium                | 32,768            | medium → `gpt-oss-120b-medium`                                                                   |

To limit which models Pi cycles through, enable specific entries in `~/.pi/agent/settings.json`:

```json
{
  "models": {
    "antigravity/gemini-3.7-flash": { "enabled": true },
    "antigravity/gemini-3.6-flash": { "enabled": true },
    "antigravity/gemini-3.5-flash": { "enabled": true },
    "antigravity/gemini-3.1-pro": { "enabled": true },
    "antigravity/claude-sonnet-4-6": { "enabled": true }
  }
}
```

## Configuration

All primary environment variables start with `ANTIGRAVITY_`. The legacy `NOAGY_` prefix is also accepted for compatibility.

| Variable                    | Purpose                                                                                                          |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `ANTIGRAVITY_BASE_URL`      | Override the API base URL. It must be HTTPS, contain no URL credentials, and target an allowed Google APIs host. |
| `ANTIGRAVITY_PROJECT_ID`    | Use a specific Cloud Code Assist project ID instead of discovery or the stable account fallback.                 |
| `ANTIGRAVITY_CALLBACK_HOST` | Bind OAuth callback to `127.0.0.1`, `::1`, or `localhost` only. Defaults to `127.0.0.1`.                         |
| `ANTIGRAVITY_USER_AGENT`    | Override the request user-agent.                                                                                 |
| `ANTIGRAVITY_RUNTIME_MODEL` | Pin requests to a runtime model ID, bypassing normal static routing.                                             |
| `ANTIGRAVITY_CLIENT_ID`     | Use a custom Google OAuth client ID.                                                                             |
| `ANTIGRAVITY_CLIENT_SECRET` | Use a custom Google OAuth client secret. Keep it out of source control and shell history.                        |

By default, the provider tries `https://cloudcode-pa.googleapis.com` and then its Google sandbox fallback if necessary. Prefer the built-in OAuth client unless you have a reason to use your own credentials.

## Troubleshooting

- **No credentials / 401 / 403:** Run `/login antigravity` again, then check `/antigravity.doctor`.
- **Remote/headless machine — browser can't reach `localhost:51121`:** The callback binds to loopback only, so a browser on another machine can't hit it. You have two options:
  - **Paste (no extra setup):** Run `/login antigravity`, open the shown URL and complete Google sign-in in _any_ browser. When it redirects to `http://localhost:51121/oauth-callback?…` and fails to load, copy that full URL from the address bar and paste it into the prompt Pi shows. The code is single-use and expires quickly, so paste promptly.
  - **SSH tunnel (reusable):** From the machine with the browser, run `ssh -N -L 51121:127.0.0.1:51121 <user>@<server>` and keep it open, then run `/login antigravity` on the server. The redirect to `localhost:51121` tunnels through to the local callback automatically.
- **OAuth callback will not start:** Ensure port `51121` is free and `ANTIGRAVITY_CALLBACK_HOST` is a permitted loopback address.
- **Model is unavailable:** Run `/antigravity.models`; availability is account- and service-dependent.
- **Claude/GPT tool-call schema error:** Upgrade to the latest package release. The provider adapts Pi's JSON Schema tool definitions for the Cloud Code Assist custom-tool bridge.
- **Quota or rate limit:** Run `/antigravity.usage`. A `429` response usually indicates quota or rate limiting; changing models may still draw from the same shared pool.
- **Need a safe diagnostic:** `/antigravity.doctor` redacts recognized secrets from its error output. Still review output before sharing it publicly.

## Development

```bash
npm install
npm run check
```

The package declares its Pi extension in `package.json` under `pi.extensions`. See the [Pi package documentation](https://pi.dev/docs/latest/packages) for package installation, manifest, and gallery conventions.

## License

[MIT](LICENSE)
