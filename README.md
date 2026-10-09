# Sereno

[![CI](https://github.com/ingenious-agency/sereno/actions/workflows/ci.yml/badge.svg)](https://github.com/ingenious-agency/sereno/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Sereno is a terminal interface for Encargado and the other resources on your Linux home server. Browse projects, worktrees, websites, infrastructure, and custom resources in one tree of nested groups. Organize them with names and labels, and run their available actions from the same interface.

Built with [OpenTUI](https://github.com/anomalyco/opentui) and TypeScript. It uses the tools already on your machine: Docker, Compose, systemd, Tailscale, Kamal proxy, and standard Linux utilities. Host discovery works on its own. When Encargado is available, Sereno imports its registered environments and controls them through its Unix-socket API.

## Getting started

You'll need Linux, **Node.js 26.4 or newer**, and **pnpm 12.10.1** (pinned in `package.json`). See [pnpm's installation guide](https://pnpm.io/installation) to install it.

```sh
git clone https://github.com/ingenious-agency/sereno.git
cd sereno
pnpm install --frozen-lockfile --ignore-scripts
pnpm start
```

To run it from anywhere:

```sh
pnpm run build
pnpm add --global .
sereno
```

Run `pnpm run build` before `pnpm add --global .`. This registers the command from your checkout's compiled build. After pulling updates or editing the source, run `pnpm run build` again. If you use mise or another Node version manager, you may need to register the command again after switching Node versions. `pnpm start` still runs directly from source during development.

### Install a release

Download the `.tgz` from [GitHub Releases](https://github.com/ingenious-agency/sereno/releases), then install it:

```sh
pnpm add --global ./sereno-0.1.0.tgz
sereno
```

Release installs are separate from the development checkout. Install a newer tarball to update, or an older one to roll back. To uninstall, run `pnpm remove --global sereno`.

Sereno isn't published to npm. The tarball comes from GitHub; pnpm still downloads its dependencies during installation. Node.js 26.4+ is required for both installation methods.

The launcher includes the experimental FFI flag required by OpenTUI. Run Sereno as your normal user; it doesn't use sudo or ask for elevated permissions. If a tool is missing or a resource isn't accessible, you'll see that in the UI.

## What's inside

### Overview

Host information, CPU usage and load averages, memory, swap, temperatures, filesystem space, running containers, and failed systemd services. Current CPU usage and load averages are shown separately—they mean different things.

### Groups

Everything is a group or a resource. Groups can contain other groups and resources; each item has one primary location. Projects, worktrees, and environments use this same model.

Encargado automatically supplies project → checkout groups, registered services, URLs, and actions. Project-scoped services appear once under Shared services, with their consumers listed in the inspector. Stopped services and their URLs remain visible. Process state, readiness, desired state, and routing errors are shown separately.

Local discovery finds project folders under `~/Work/Projects`, Git worktrees, Docker containers, systemd units, processes, listeners, and routes. Recognized owners receive Start, Stop, Restart, and Logs actions. Unknown resource types have no inferred lifecycle actions. Shared resources appear in Shared infrastructure; other resources without a location appear in Ungrouped.

Runtime observations with exact systemd or Compose ownership are attached to the corresponding Encargado resource. Managed lifecycle actions call Encargado. Resource names and port numbers alone never establish managed ownership.

Press `g` to create a group, `m` to move an item, `n` to rename it, or Shift+L to edit comma-separated labels. Enter opens nested groups and resource details. Saved names, labels, and locations survive discovery refreshes. Removing a group from configuration leaves its resources in Ungrouped.

An unavailable integration keeps its last inventory visible for the current session and disables its actions. Sereno's host discovery continues independently. Integration inventory is refreshed every 30 seconds; `r` refreshes it immediately.

### Website resources

Websites live inside their groups alongside services and other resources. Encargado's registered URLs appear alongside Tailscale, Funnel, Kamal, manual routes, and configured website resources. There is no separate Sites section.

A registered URL, a listening backend, and a successful HTTP response are separate facts. A stopped Encargado application can still have a persistent URL serving its Start page. That URL stays grouped with its application.

Press `o` to open a website. Host and configured websites offer `h` for a single HTTP HEAD check; Encargado URLs offer its Verify operation. Redirects and authentication responses are reported as received. Actions and their output are available in the resource inspector.

### Storage

Filesystem capacity, project folders, common tool caches, and Docker images, volumes, and build cache. Filesystems mounted in multiple places are counted once.

Folder scans run only when you ask for them. Press `s` to scan, Enter to drill down, and `c` to cancel. Results show when they were collected and whether the scan was partial.

Folder totals aren't the same as physical disk usage, especially with Btrfs compression, reflinks, and snapshots. Docker's reclaimable-space figures are estimates too.

## Keyboard shortcuts

| Key                       | Action                                     |
| ------------------------- | ------------------------------------------ |
| `1`–`3`, Tab, ←/→         | Switch sections                            |
| ↑/↓, `j`/`k`              | Move selection                             |
| Enter / Escape            | Open details / go back                     |
| `/`                       | Search the current list                    |
| Ctrl+P                    | Open the command palette                   |
| `?`                       | Show shortcuts                             |
| `r`                       | Refresh                                    |
| `v`                       | Show full details                          |
| `g` / `m` / `n` / Shift+L | Create group / move / rename / edit labels |
| `l`                       | View recent logs                           |
| `s` / `x` / `t`           | Start / stop / restart when available      |
| Shift+A                   | Open the selected item's action menu       |
| `o` / `h`                 | Open a site / check its HTTP response      |
| `s` / `c`                 | Scan a folder / cancel a running command   |
| `b` in Storage            | Preview Docker build-cache cleanup         |
| `e`                       | Ask AI to explain what you're looking at   |
| `z`                       | Reopen the last command output             |
| `q`, Ctrl+C               | Quit                                       |

On wider terminals, the inspector shows details alongside your selection. On smaller terminals, use Enter or `v` for the full view.

## Actions

Resources and groups expose actions supplied by their integration or defined in configuration. Open an item to see its action rows, or press Shift+A for the action menu. Start (`s`), Stop (`x`), Restart (`t`), Logs (`l`), Open (`o`), and Check/Verify (`h`) shortcuts appear when available.

Every action shows its target and execution before running. Press `y` to run or Escape to cancel. Sereno refreshes the target and rechecks the action after confirmation. Changed actions, disappeared resources, or unavailable information require another preview. Command output includes stdout, stderr, exit status, and the state observed after refresh.

Group actions are explicit. An Encargado checkout's Start calls `up` and its Stop calls `stop`. Encargado handles dependency ordering, shared-service protections, readiness, and routing. A manual group controls resources only through an action configured for that group; placing a resource inside it does not create a lifecycle operation.

Host actions control the identified systemd unit, Compose service, or standalone container. Compose actions affect all replicas of that service and operate on existing containers without loading deleted worktree files. Sereno does not infer launch recipes for unmanaged processes. Define a resource with explicit commands to control a custom application.

Press `c` to cancel a command or disconnect an API request. Disconnecting from Encargado does not cancel its server-side lifecycle operation; refresh its state before retrying. Actions never remove containers, volumes, files, or routes automatically.

The old project stop/resume set is not used by the group interface. Encargado Start uses its declared recipes; custom Start uses its configured command.

## Cleanup

Press `b` in Storage to inspect Docker usage and preview cleanup of dangling build cache older than seven days:

```sh
docker builder prune --filter until=168h --force
```

The inventory is not an exact dry run; Docker determines what can be removed when the command runs. Sereno doesn't remove database volumes, project files, or arbitrary cache directories, and it never schedules cleanup automatically.

## AI explanations

Press `e` on a resource, metric, or dialog to get an explanation. Escape closes and cancels the explanation without disturbing the dialog underneath.

By default, Sereno uses **Codex CLI with your ChatGPT subscription**, not an API key:

```sh
pnpm add --global @openai/codex
codex login
```

For a headless server, use `codex login --device-auth`. You'll need a current Codex version supporting `exec --ignore-user-config --ephemeral --json`.

Codex runs locally, but its inference is hosted by OpenAI and uses your plan's allowances. Sereno requires ChatGPT sign-in and doesn't fall back to API billing. The explanation session has a read-only sandbox with shell tools, web search, and hooks disabled.

For a local model, install Ollama, start it, pull a model, and add this to your config:

```json
"explain": {
  "provider": "ollama",
  "model": "qwen3:8b"
}
```

Sereno connects to Ollama at `127.0.0.1:11434`. Choose an installed local model, not a cloud model. Sereno doesn't download models or manage Ollama for you.

Explanations use a bounded snapshot of the selected item and related dashboard data. If you're viewing logs, their displayed text is included. Common secrets are redacted, but log redaction isn't foolproof. No repository files or environment dumps are included, and no AI requests run automatically.

## Configuration

Configuration lives in `~/.config/sereno/config.json`. Set `SERENO_CONFIG` to use a different file. Interactive organization changes are saved atomically; edits made outside Sereno take effect on the next launch.

`organization` contains group definitions, custom resource definitions, and overrides for imported items. Provider inventory and live status are never written into this configuration.

```json
{
  "projectRoots": ["~/Work/Projects"],
  "encargado": { "enabled": true },
  "organization": {
    "version": 1,
    "groups": [
      { "id": "infra", "name": "Infrastructure" },
      { "id": "databases", "name": "Databases", "parent": "infra" }
    ],
    "resources": [
      {
        "id": "docs",
        "name": "Documentation",
        "parent": "infra",
        "type": "website",
        "details": { "URL": "https://example.com/" }
      },
      {
        "id": "worker",
        "name": "Local worker",
        "parent": "infra",
        "actions": [
          {
            "id": "start",
            "label": "Start",
            "execution": {
              "type": "command",
              "command": {
                "file": "./bin/worker-start",
                "args": [],
                "cwd": "/home/user/Work/Projects/my-app"
              }
            }
          }
        ]
      }
    ],
    "placements": [
      {
        "resource": "compose:my-app:postgres",
        "group": "databases",
        "name": "Application database",
        "labels": ["local"]
      }
    ]
  }
}
```

Groups and resources require unique `id` and `name` fields. Optional `parent` selects a group; top-level groups omit it. Resources with a missing parent appear in Ungrouped. Optional `labels`, `description`, `details`, and `actions` apply to both. Nest groups to represent any environment or collection; cycles are rejected.

Use `v` to inspect an imported item's stable ID. Placements can override its `group`, `name`, `labels`, and `actions`. A placement with `group: null` moves a resource to Ungrouped or a group to the top level. Omitted override fields retain the imported values; an explicit `actions: []` removes actions. Unresolved placements are retained for later discovery.

Encargado IDs are opaque and survive runtime recreation. Host Compose IDs use `compose:<project>:<service>`; systemd IDs use `systemd:user:<unit>` or `systemd:system:<unit>`. Standalone containers retain their immutable container IDs. Processes use their PID plus observed start identity, so PID reuse cannot inherit a saved organization override. Moving an Encargado repository or worktree requires explicit reconciliation in Encargado.

Custom command actions require `id`, `label`, and `execution`. `description` is optional. `confirm` defaults to true. Commands use `file` and an argument array, with optional absolute `cwd`, `timeout` in milliseconds, `limit` in bytes, `stdin`, and `env`. Arguments are passed directly to the executable. To run a shell script, point `file` at the script or explicitly configure a shell executable. Reference private environment files in your scripts rather than putting secrets in this configuration.

Custom resources can supply `probe` using the same command format. Probes run during refresh, so use a bounded, read-only status command. Its stdout becomes the resource's status. A nonzero exit can report a stopped or failed state while keeping Start available; a missing command, cancellation, timeout, or truncated output makes observation unavailable. A resource without a probe displays unknown status. Website resources with `details.URL` receive Open and Check HTTP actions automatically when no actions are supplied.

Encargado connection resolution supports `encargado.socket`, `ENCARGADO_SOCKET`, `ENCARGADO_HOME`, and its standard XDG runtime location. Set `encargado.enabled: false` to disable the integration. Sereno reads the public API, not the registry's private launch environments.

Existing `projectRoots`, `mappings`, and `sites` configurations continue to load. Legacy assignments seed the initial host grouping; many-project assignments go into Shared infrastructure. New interactive edits use placements. Configured organization takes precedence over detected placement.

An agent can write the same configuration you edit manually. Export the organization JSON Schema and validate the complete configuration before opening the TUI:

```sh
sereno --organization-schema
SERENO_CONFIG=/path/to/config.json sereno --validate-config
```

Validation does not discover resources, run probes, or execute actions. See [config.example.json](config.example.json) for a nested organization with custom Start, Stop, and status commands.

## Limitations

Sereno is for one local Linux machine. It doesn't deploy apps, manage remote servers, collect historical metrics, or replace your existing tools. Use a local Docker context.

Discovery depends on your access. Other users' process directories and socket ownership may be hidden. Only loaded systemd services are listed. Site discovery currently covers Tailscale HTTP routes and the Kamal proxy v0.9.x list format; other proxies and more complex routing may need manual entries.

CPU and memory measurements from processes, containers, and service cgroups can overlap, so Sereno doesn't add them into misleading project totals. Storage inspection doesn't calculate Btrfs exclusive extents or snapshot usage.

## Development

```sh
pnpm run fixtures       # Browse sample data without executing actions
pnpm run smoke          # Print a live discovery snapshot
pnpm run format         # Format source, tests, configuration, and documentation
pnpm run format:check   # Check formatting without changing files
pnpm run check          # TypeScript checks
pnpm test
```

`src/domain.ts` defines groups, resources, actions, tree reconciliation, and action planning. `src/application.ts` owns refresh, organization persistence, and execution policy through Effect v4 services and injected layers. Providers translate external systems into the domain; OpenTUI reads the resulting tree through the store facade. The existing bounded runner handles command execution. Metrics refresh frequently; discovery runs less often; directory scans happen on demand. Tests cover parsing, associations, navigation, and action targeting. Lifecycle tests use mocked execution.

To build a release tarball without publishing to npm:

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm run format:check
pnpm run check
pnpm test
pnpm pack
```

`pnpm pack` builds the app first. The package includes the launcher, compiled JavaScript, README and configuration example. Tests, recordings, TypeScript source and development dependencies aren't included. `private: true` guards against accidental npm publication.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for setup, checks, and pull requests. Use fixture data for public examples and screenshots. Report security vulnerabilities through [private security reporting](SECURITY.md).

## License

[MIT](LICENSE) © 2026 Sereno Contributors.
