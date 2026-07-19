# pi-antigravity

[![npm version](https://img.shields.io/npm/v/pi-antigravity?logo=npm)](https://www.npmjs.com/package/pi-antigravity)
[![license](https://img.shields.io/npm/l/pi-antigravity)](LICENSE)

A Pi Coding Agent provider for Google Antigravity / Cloud Code Assist models. It adds provider `antigravity`, Google OAuth login, native streaming, model routing, and quota diagnostics—without invoking an external Antigravity CLI.

> **Unofficial integration.** This project is not affiliated with or endorsed by Google. Use it only with an account and services you are authorized to access, and review its source before granting OAuth permissions.

## Requirements

- Pi Coding Agent and Pi AI version **0.80.0 or later**
- A Google account that can use the relevant Cloud Code Assist / Antigravity services
- A browser on the same machine as Pi for the OAuth sign-in flow

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
   /model antigravity/gemini-3.5-flash
   ```

4. Start working. Use `/antigravity.doctor` if a request fails.

## Authentication and credential safety

The provider uses OAuth 2.0 Authorization Code flow with PKCE.

1. `/login antigravity` opens Google sign-in and starts a temporary callback listener at `http://localhost:51121/oauth-callback`.
2. After approval, Pi exchanges the callback code for tokens and stores the provider credentials in Pi's auth store (normally `~/.pi/agent/auth.json`).
3. Pi refreshes access tokens when needed.

The callback listener binds only to a loopback host. The auth file contains sensitive access and refresh tokens: do not commit it, paste it into issues, or share its contents.

The login requests these Google OAuth scopes:

- `cloud-platform`
- `userinfo.email` and `userinfo.profile`
- `cclog`
- `experimentsandconfigs`

Review these permissions before approving access. Re-run `/login antigravity` to replace expired or revoked credentials.

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

The static model IDs registered by this extension match the Antigravity CLI catalog (`agy models`). Use `/antigravity.models` to see live availability and quota for your account.

`agy models` currently lists eight display entries (Flash Low/Medium/High, Pro Low/High, Claude Sonnet/Opus Thinking, GPT-OSS Medium). Pi collapses those into five public model IDs and maps Low/Medium/High through thinking effort.

### Why Claude and GPT-OSS appear

Antigravity / Cloud Code Assist exposes a multi-provider catalog. Depending on your account, its Google-authenticated API can advertise Google Gemini models alongside Claude models served through Anthropic Vertex and GPT-OSS served through OpenAI Vertex. This extension intentionally exposes those advertised Claude and GPT-OSS models through the single `antigravity` provider; they are not separate Pi providers and do not use a separate Anthropic or OpenAI login.

The backend's display labels do not always match its runtime IDs. For example, `gemini-3.5-flash-extra-low`, `gemini-3.5-flash-low`, and `gemini-3-flash-agent` can be displayed as Gemini 3.5 Flash Low, Medium, and High. The routing below uses the runtime IDs returned by the service.

| Public model ID     | Input       | Thinking | Request routing                                                                                                      |
| ------------------- | ----------- | -------- | -------------------------------------------------------------------------------------------------------------------- |
| `gemini-3.5-flash`  | Text, image | Yes      | Off/minimal → `gemini-3.5-flash-extra-low`; low/medium → `gemini-3.5-flash-low`; high/xhigh → `gemini-3-flash-agent` |
| `gemini-3.1-pro`    | Text, image | Yes      | Off/minimal/low/medium → `gemini-3.1-pro-low`; high/xhigh → `gemini-pro-agent`                                       |
| `claude-sonnet-4-6` | Text, image | Yes      | `claude-sonnet-4-6` for every effort level                                                                           |
| `claude-opus-4-6`   | Text, image | Yes      | `claude-opus-4-6-thinking`                                                                                           |
| `gpt-oss-120b`      | Text        | Yes      | `gpt-oss-120b-medium`                                                                                                |

To limit which models Pi cycles through, enable specific entries in `~/.pi/agent/settings.json`:

```json
{
  "models": {
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
| `ANTIGRAVITY_PROJECT_ID`    | Use a specific Cloud Code Assist project ID instead of discovery or the local stable fallback.                   |
| `ANTIGRAVITY_CALLBACK_HOST` | Bind OAuth callback to `127.0.0.1`, `::1`, or `localhost` only. Defaults to `127.0.0.1`.                         |
| `ANTIGRAVITY_USER_AGENT`    | Override the request user-agent.                                                                                 |
| `ANTIGRAVITY_RUNTIME_MODEL` | Pin requests to a runtime model ID, bypassing normal static routing.                                             |
| `ANTIGRAVITY_CLIENT_ID`     | Use a custom Google OAuth client ID.                                                                             |
| `ANTIGRAVITY_CLIENT_SECRET` | Use a custom Google OAuth client secret. Keep it out of source control and shell history.                        |

By default, the provider tries `https://cloudcode-pa.googleapis.com` and then its Google sandbox fallback if necessary. Prefer the built-in OAuth client unless you have a reason to use your own credentials.

## Troubleshooting

- **No credentials / 401 / 403:** Run `/login antigravity` again, then check `/antigravity.doctor`.
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
