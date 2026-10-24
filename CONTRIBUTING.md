# Contributing

Thanks for improving `pi-antigravity`.

## Before opening an issue

- Search existing issues first.
- Do not report security vulnerabilities in public issues; follow [SECURITY.md](SECURITY.md).
- Include the Pi version, package version, operating system, selected model, and sanitized `/antigravity.doctor` output when reporting a bug.

## Development setup

```bash
corepack enable
yarn install --immutable
yarn check
```

This repo uses [Yarn 4](https://yarnpkg.com/) through Corepack (Node 22.19.0 or later). `yarn check` runs TypeScript, ESLint, Prettier, tests, and `yarn npm audit`. Installs disable lifecycle scripts, verify lockfile checksums against the npm registry, and refuse package versions newer than three days. Run it before opening a pull request.

## Pull requests

1. Fork the repository and create a focused branch.
2. Keep changes small and explain their user impact.
3. Add or update tests when behavior changes.
4. Update documentation when commands, authentication, configuration, or models change.
5. Ensure `yarn check` passes.

Do not include credentials, access tokens, refresh tokens, OAuth client secrets, or private account data in commits, issues, pull requests, or logs.

## Releases

Maintainers publish releases by pushing a version tag (`vX.Y.Z`). Contributors must not publish the package or modify release credentials.
