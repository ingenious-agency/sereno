# Sereno

[![CI](https://github.com/ingenious-agency/sereno/actions/workflows/ci.yml/badge.svg)](https://github.com/ingenious-agency/sereno/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Sereno is a terminal dashboard for your Linux home server. See what's running, which project it belongs to, how your sites are routed, and where your disk space is going—all without switching between a dozen commands.

Built with [OpenTUI](https://github.com/anomalyco/opentui) and TypeScript. It uses the tools already on your machine: Docker, Compose, systemd, Tailscale, Kamal proxy, and standard Linux utilities. There's no background daemon or separate monitoring service to set up.

## Getting started

You'll need Linux, **Node.js 26.4 or newer**, and npm.

```sh
git clone https://github.com/ingenious-agency/sereno.git
cd sereno
npm ci
npm start
```

To run it from anywhere:

```sh
npm run build
npm link
sereno
```

Run `npm run build` before `npm link`. This links the command to your checkout's compiled build. After pulling updates or editing the source, run `npm run build` again. If you use mise or another Node version manager, you may need to run `npm link` again after switching Node versions. `npm start` still runs directly from source during development.

### Install a release

Download the `.tgz` from [GitHub Releases](https://github.com/ingenious-agency/sereno/releases), then install it:

```sh
npm install --global ./sereno-0.1.0.tgz
sereno
```

Release installs are separate from the development checkout. Install a newer tarball to update, or an older one to roll back. To uninstall, run `npm uninstall --global sereno`.

Sereno isn't published to npm. The tarball comes from GitHub; npm still downloads its dependencies during installation. Node.js 26.4+ is required for both installation methods.

The launcher includes the experimental FFI flag required by OpenTUI. Run Sereno as your normal user; it doesn't use sudo or ask for elevated permissions. If a tool is missing or a resource isn't accessible, you'll see that in the UI.

## What's inside

### Overview

Host information, CPU usage and load averages, memory, swap, temperatures, filesystem space, running containers, and failed systemd services. Current CPU usage and load averages are shown separately—they mean different things.

### Projects

Sereno discovers directories under `~/Work/Projects`, including Git worktrees outside that directory. Each project brings together its containers, services, processes, listening ports, and sites.

Resources have three kinds of association:

- **Detected:** backed by metadata, such as a Compose working directory or a process's current directory.
- **Suggested:** a possible match, usually based on a name. It needs your confirmation.
- **Assigned:** a mapping you've made yourself.

Press `a` to assign a resource to one or more projects. Shared and unmatched resources stay visible under **Shared infrastructure / Unassigned**.

### Sites

Routes from Tailscale Serve, Funnel, Services, and Kamal proxy, with their access scope, proxy chain, and backend. You can add sites manually too.

Route configuration, backend availability, and HTTP responses are separate. A configured route doesn't mean the backend is alive. Press `h` for a single HTTP HEAD check or `o` to open the site in your browser. Redirects and authentication responses aren't automatically treated as failures.

### Storage

Filesystem capacity, project folders, common tool caches, and Docker images, volumes, and build cache. Filesystems mounted in multiple places are counted once.

Folder scans run only when you ask for them. Press `s` to scan, Enter to drill down, and `c` to cancel. Results show when they were collected and whether the scan was partial.

Folder totals aren't the same as physical disk usage, especially with Btrfs compression, reflinks, and snapshots. Docker's reclaimable-space figures are estimates too.

## Keyboard shortcuts

| Key | Action |
| --- | --- |
| `1`–`4`, Tab, ←/→ | Switch sections |
| ↑/↓, `j`/`k` | Move selection |
| Enter / Escape | Open details / go back |
| `/` | Search the current list |
| Ctrl+P | Open the command palette |
| `?` | Show shortcuts |
| `r` | Refresh |
| `v` | Show full details |
| `a` | Assign a resource to projects |
| `l` | View recent logs |
| `x` / `t` | Stop / restart a resource |
| Shift+X | Preview stopping a project's services |
| `o` / `h` | Open a site / check its HTTP response |
| `s` / `c` | Scan a folder / cancel a running command |
| `b` in Storage | Preview Docker build-cache cleanup |
| `e` | Ask AI to explain what you're looking at |
| `z` | Reopen the last command output |
| `q`, Ctrl+C | Quit |

On wider terminals, the inspector shows details alongside your selection. On smaller terminals, use Enter or `v` for the full view.

## Stopping services

Sereno shows the target, command, and scope before stopping or restarting anything. Press `y` to confirm or Escape to cancel. Results include stdout, stderr, the exit status, and the state observed after refreshing.

Compose services are controlled through Compose, systemd services through systemd, and standalone containers through Docker. Compose actions select existing containers by project/service labels, so they still work if the original worktree or Compose files have been deleted. Stopping a Compose service affects all its replicas.

To stop a project's services, open the project and press **Shift+X**. The preview includes only confirmed resources belonging exclusively to that project. Shared resources, uncertain matches, stale data, and infrastructure such as the Kamal proxy, Tailscale, and registry are excluded. Every exclusion has a reason.

Kamal app and database containers can be included once their association is confirmed. The shared proxy and routes stay configured. Development servers can be stopped with SIGTERM when Sereno can verify that they're same-user, unmanaged listening processes. This requires Python 3 and Linux pidfd support. Servers inside shared editor or service process trees may need to be stopped in their original terminal instead.

The project plan is checked again before each command. A failure, changed target, or cancellation stops the rest of the batch. Completed actions aren't rolled back, and a parent watcher may respawn a development server.

Nothing in a project stop removes containers, volumes, files, or routes.

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
npm install -g @openai/codex
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

Sereno connects to Ollama's HTTP API at `127.0.0.1:11434` using curl, without proxies or redirects. Choose an installed local model, not a cloud model or remote alias. Set `OLLAMA_NO_CLOUD=1` on the **Ollama daemon**, not just the Sereno process, and restart the daemon yourself after configuring it. Sereno requires `/api/status` to report cloud features disabled and `/api/show` to report local GGUF or safetensors metadata before sending any snapshot. Older daemons without that status endpoint fail closed; update Ollama to use this provider.

Generation uses `/api/generate`, which fails if the model disappears instead of automatically pulling it. Sereno doesn't download models or manage Ollama for you. These checks trust the loopback daemon and its configuration; keep cloud features disabled for the entire request. For a strong local-only guarantee, also deny the daemon outbound network access (including across configuration changes or restarts).

Explanations use a bounded snapshot of the selected item and related dashboard data. If you're viewing logs, their displayed text is included. Common secrets are redacted, but log redaction isn't foolproof. No repository files or environment dumps are included, and no AI requests run automatically.

## Configuration

Configuration lives in `~/.config/sereno/config.json`. Set `SERENO_CONFIG` to use a different file. Without a config, Sereno looks in `~/Work/Projects`.

```json
{
  "projectRoots": ["~/Work/Projects"],
  "mappings": [
    {
      "resource": "systemd:user:my-app.service",
      "projects": ["~/Work/Projects/my-app"]
    }
  ],
  "sites": [
    {
      "url": "http://localhost:3000/",
      "scope": "localhost",
      "backend": "http://127.0.0.1:3000",
      "projects": ["~/Work/Projects/my-app"]
    }
  ]
}
```

Use `v` to find a resource's ID. A mapping replaces the inferred associations; an empty `projects` list leaves the resource explicitly unassigned. Container mappings use full IDs, so they need updating after a container is recreated. Interactive assignments are saved immediately; other config edits take effect on the next launch.

See [config.example.json](config.example.json) for another example.

## Limitations

Sereno is for one local Linux machine. It doesn't deploy apps, manage remote servers, collect historical metrics, or replace your existing tools. Use a local Docker context.

Discovery depends on your access. Other users' process directories and socket ownership may be hidden. Only loaded systemd services are listed. Site discovery currently covers Tailscale HTTP routes and the Kamal proxy v0.9.x list format; other proxies and more complex routing may need manual entries.

CPU and memory measurements from processes, containers, and service cgroups can overlap, so Sereno doesn't add them into misleading project totals. Storage inspection doesn't calculate Btrfs exclusive extents or snapshot usage.

## Development

```sh
npm run fixtures   # Browse sample data without executing actions
npm run smoke      # Print a live discovery snapshot
npm run check      # TypeScript checks
npm test
```

The app is organized around collectors, a normalized resource model, OpenTUI views, and a bounded command runner. Metrics refresh frequently; discovery runs less often; directory scans happen on demand. Tests cover parsing, associations, navigation, and action targeting. Lifecycle tests use mocked execution.

To build a release tarball without publishing to npm:

```sh
npm ci
npm run check
npm test
npm pack
```

`npm pack` builds the app first. The package includes the launcher, compiled JavaScript, README and configuration example. Tests, recordings, TypeScript source and development dependencies aren't included. `private: true` guards against accidental npm publication.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for setup, checks, and pull requests. Use fixture data for public examples and screenshots. Report security vulnerabilities through [private security reporting](SECURITY.md).

## License

[MIT](LICENSE) © 2026 Sereno Contributors.
