# pi-antigravity

Personal Pi Coding Agent provider for Google Antigravity / Cloud Code Assist models.

- **Provider id**: `antigravity`
- **Auth**: `/login antigravity` (OAuth credentials stored securely in `~/.pi/agent/auth.json`)
- **Transport**: Native `streamSimple` → Cloud Code Assist SSE
- **No external CLI dependencies**: Does **not** require shell execution of the Antigravity CLI.

---

## Table of Contents
- [Features](#features)
- [Install](#install)
- [Authentication](#authentication)
- [Usage & Commands](#usage--commands)
- [Preferred Models](#preferred-models)
- [How Model Quotas and Routing Work](#how-model-quotas-and-routing-work)
- [Configuration and Env Overrides](#configuration-and-env-overrides)
- [Diagnostics & Troubleshooting](#diagnostics--troubleshooting)
- [How to Publish this Package](#how-to-publish-this-package)

---

## Features

- **Direct Native Streaming**: Translates request formats into Gemini-style (`contents` / `parts`) messages directly on the fly.
- **Interactive OAuth flow**: Logs you in securely inside Pi using your Google account and configures local OAuth callback capture.
- **Intelligent Thinking Support**: Implements `ThinkingEffort` configuration, mapping to correct backend thinking models depending on model capabilities.
- **Quota Pool Analytics**: Tracks pool usage across models to avoid unexpected depletion.

---

## Install

Run the following command inside your Pi terminal to install:

```bash
# Install via npm (when published)
pi install npm:pi-antigravity

# Or install directly from GitHub
pi install git:github.com/username/pi-antigravity
```

---

## Authentication

Authentication uses Google OAuth 2.0 PKCE. 
1. Run `/login antigravity` in Pi.
2. Pi starts a temporary callback server on `http://localhost:51121/oauth-callback` and opens your browser to the Google Sign-In page.
3. Complete the authentication flow and approve the requested Google Cloud/experiments scopes.
4. Pi captures the authorization code, exchanges it for access and refresh tokens, and saves them to `~/.pi/agent/auth.json`.
5. Access tokens are automatically refreshed in the background when they expire.

---

## Usage & Commands

Once installed, use the following commands in the Pi chat interface:

| Command | Description | Example |
| :--- | :--- | :--- |
| `/login antigravity` | Authenticates with Google Cloud and initializes the provider. | `/login antigravity` |
| `/model antigravity/<model-id>` | Selects a model hosted by the Antigravity provider. | `/model antigravity/gemini-3.5-flash` |
| `/antigravity.usage` | Renders shared pool usage metrics (weekly + 5-hour pools) using visual progress bars. | `/antigravity.usage` |
| `/antigravity.models` | Lists available runtime models, remaining pool fraction, and flags like `thinking` / `images`. | `/antigravity.models` |
| `/antigravity.doctor` | Shows connection diagnostics (last endpoint, last status code, last resolved model). | `/antigravity.doctor` |

---

## Preferred Models

Enable selected models in your Pi settings file (`~/.pi/agent/settings.json`):

```json
{
  "models": {
    "antigravity/gemini-3.5-flash": { "enabled": true },
    "antigravity/gemini-3.1-pro": { "enabled": true },
    "antigravity/claude-sonnet-4-6": { "enabled": true }
  }
}
```

### Full Model Routing Matrix

| Public id | Capabilities | Notes / Fallbacks |
| :--- | :--- | :--- |
| `gemini-3.5-flash` | Text + Images + Thinking | Effort routes to `extra-low` / `low` / `agent` |
| `gemini-3.1-pro` | Text + Images + Thinking | Effort routes to `low` / `high` |
| `gemini-3-flash` | Text + Images + Thinking | Routes to `gemini-3-flash` |
| `gemini-2.5-pro` | Text + Images + Thinking | Routes to `gemini-2.5-pro` |
| `gemini-2.5-flash` | Text + Images + Thinking | Routes to `MODEL_GOOGLE_GEMINI_2_5_FLASH` |
| `claude-sonnet-4-6` | Text + Images + Thinking | Default direct; `high`/`xhigh` routes to thinking variant |
| `claude-opus-4-6` | Text + Images + Thinking | Routes to `claude-opus-4-6-thinking` |
| `gpt-oss-120b` | Text + Thinking | Routes to `gpt-oss-120b-medium` |

---

## How Model Quotas and Routing Work

### Quota Pools (Shared Budgets)
Google Antigravity allocates quotas to shared pools rather than per-model limits. 

1. **Gemini Pool**: Contains `gemini-3.5-flash`, `gemini-3.1-pro`, `gemini-2.5-pro`, and other Gemini models.
2. **Claude & GPT Pool**: Contains `claude-sonnet-4-6`, `claude-opus-4-6`, and `gpt-oss-120b`.

> **Note**: Quota is consumed proportionally to token cost. High-resource models (like Opus or Pro) will deplete your shared pool significantly faster than lower-cost models (like Flash or Sonnet).

---

## Configuration and Env Overrides

You can configure several variables to override default endpoint behaviors or client properties. Prefix them with `ANTIGRAVITY_`:

- `ANTIGRAVITY_BASE_URL`: Custom backend endpoint (defaults to `https://cloudcode-pa.googleapis.com`).
- `ANTIGRAVITY_PROJECT_ID`: Force a specific Google Cloud Project ID (defaults to automatic discovery or stable hash of CWD).
- `ANTIGRAVITY_CALLBACK_HOST`: Host to bind the callback server to (defaults to `127.0.0.1`).
- `ANTIGRAVITY_USER_AGENT`: Custom user-agent string for headers.
- `ANTIGRAVITY_RUNTIME_MODEL`: Pin requests to a specific model ID instead of dynamic routing.
- `ANTIGRAVITY_CLIENT_ID` / `ANTIGRAVITY_CLIENT_SECRET`: Custom Google OAuth app credentials.

---

## Diagnostics & Troubleshooting

Run `/antigravity.doctor` to check diagnostics:
- **`lastStatus`**: Check if Google returned `200` (OK), `401`/`403` (auth/permission error), or `429` (rate/quota limit).
- **`lastError`**: Raw error messages returned from the backend.
- **`lastResolvedRuntimeModel`**: The actual model ID used in the final HTTP request.

### Common Solutions:
1. **Invalid API Key/Credentials**: Run `/login antigravity` again to refresh tokens.
2. **Permission Denied**: Make sure your Google Account has Google Cloud Platform developer access or companion project entitlements enabled.

---

## How to Publish this Package

To share this provider package to the Pi Coding Agent package ecosystem, follow these steps:

### Step 1: Prep and Authenticate with npm
Ensure your package configuration is clean. Since we use `files` in `package.json`, only the `src` directory, `README.md`, and `tsconfig.json` will be published to keep the footprint small.

```bash
# Run build validation one final time
npm run check

# Log in to your npm registry account
npm login
```

### Step 2: Publish to the npm Registry
Run the publish command to upload your package:

```bash
npm publish --access public
```

### Step 3: Publish via GitHub (Alternative)
You can also share it directly via GitHub. Ensure the repository is public and add the tag/release:

```bash
git init
git add .
git commit -m "feat: initial release of pi-antigravity"
git remote add origin git@github.com:username/pi-antigravity.git
git branch -M main
git push -u origin main

# Tag a version (e.g., v0.1.0)
git tag v0.1.0
git push origin v0.1.0
```

### Step 4: Verification
Install your newly published package globally or in a local project to verify it loads correctly:

```bash
# Install from npm
pi install npm:pi-antigravity

# Or install from git
pi install git:github.com/username/pi-antigravity
```
Verify that the commands `/login antigravity` and `/antigravity.doctor` show up in Pi.
