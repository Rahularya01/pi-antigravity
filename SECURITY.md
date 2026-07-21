# Security Policy

## Supported versions

Security fixes are applied to the latest published `0.1.x` release. Please upgrade to the latest version before reporting an issue.

## Reporting a vulnerability

Please **do not** open a public issue for a suspected vulnerability.

Use [GitHub private vulnerability reporting](https://github.com/Rahularya01/pi-antigravity/security/advisories/new) to send a report directly to the maintainers. Include:

- a clear description and impact assessment;
- reproducible steps or a minimal proof of concept;
- affected versions and environment details; and
- a suggested remediation, if available.

We will acknowledge valid reports, investigate them privately, and coordinate a fix and disclosure. Do not include OAuth access tokens, refresh tokens, client secrets, or other credentials in your report.

## Scope

This repository contains a Pi extension that handles OAuth credentials and sends requests to Cloud Code Assist endpoints. Reports involving credential exposure, unsafe endpoint handling, OAuth callback validation, request construction, dependency vulnerabilities, or release automation are in scope.

## OAuth client credentials

By default the extension uses Google's **public Antigravity desktop OAuth client** (the same client ID/secret embedded in the Antigravity app and other community tools). That value is not a private application secret: anyone with the package can extract it. Treat access and refresh tokens in `~/.pi/agent/auth.json` as the real secrets.

To use your own Google Cloud OAuth client instead, set `ANTIGRAVITY_CLIENT_ID` and `ANTIGRAVITY_CLIENT_SECRET`. Keep those out of source control and shell history.
