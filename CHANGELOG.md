# Changelog

All notable changes to this project are documented in this file.

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
