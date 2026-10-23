# Contributing to Sereno

Sereno is a dashboard for one local Linux machine. Bug fixes, clearer documentation, and focused improvements are welcome. Open an issue before substantial features or new dependencies so we can agree on the scope.

## Development

Use Linux, Node.js 26.4 or newer, and the pnpm version pinned in `package.json`:

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm run fixtures
```

Fixture mode uses sample data and disables commands, configuration writes, and AI requests. Use it for public screenshots and reproductions. Live discovery output can contain private project names, hostnames, addresses, and paths; do not attach raw snapshots, local configuration, credentials, or live recordings to public reports.

Before submitting a change:

```sh
pnpm run format
pnpm run format:check
pnpm run check
pnpm test
pnpm run build
```

Prettier formats source, tests, configuration, workflows, and documentation. CI checks formatting without changing files. Commit dependency changes with `pnpm-lock.yaml`; use `pnpm add` or `pnpm remove` to update dependencies.

Lifecycle tests use mocked execution. Add focused regression coverage for behavior changes; tests must not stop real services, prune storage, or call AI providers.

## Pull requests

1. Fork the repository and work on a branch.
2. Keep the change focused and describe the problem, solution, and verification.
3. Open a pull request against `main`. CI checks the minimum and current Node.js 26 versions. Workflows from external contributors need maintainer approval before running.
4. Resolve review conversations and wait for passing checks. Changes are squash-merged, and merged branches are deleted automatically.

Be respectful and constructive. Contributions are provided under the project's [MIT license](LICENSE).

For vulnerabilities, follow [SECURITY.md](SECURITY.md) and report privately before opening a public issue.
