import type { Resource, Site } from "./model.ts";
import { safeUrl, type Command, type Runner, type Result } from "./runner.ts";

export interface Action {
  target: string;
  scope: string;
  command: Command;
  destructive: boolean;
  refresh: "resources" | "storage" | "none";
  resourceId?: string;
  verb?: string;
}
export function resourceAction(
  resource: Resource,
  verb: "logs" | "stop" | "restart" | "start",
): Action {
  const owner = resource.owner;
  if (!owner)
    throw new Error(
      "No supported lifecycle owner. Inspect related resources; arbitrary process signals are not supported.",
    );
  const logs = verb === "logs";
  let command: Command, scope: string;
  if (owner.kind === "systemd") {
    if (!owner.id.endsWith(".service") || owner.id.startsWith("-") || owner.id.includes("\0"))
      throw new Error("Invalid systemd service target");
    command = logs
      ? {
          file: "journalctl",
          args: [
            ...(owner.user ? ["--user"] : []),
            "--unit",
            owner.id,
            "--lines",
            "150",
            "--since",
            "30 minutes ago",
            "--no-pager",
            "--output=short-iso",
          ],
        }
      : {
          file: "systemctl",
          args: [...(owner.user ? ["--user"] : []), "--no-ask-password", verb, "--", owner.id],
        };
    scope = `${owner.user ? "User" : "System"} unit ${owner.id}; affects its entire service cgroup. No privilege escalation.`;
  } else if (owner.kind === "compose") {
    if (
      !owner.project ||
      !/^[a-z0-9][a-z0-9_-]*$/.test(owner.project) ||
      !owner.service ||
      !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(owner.service)
    )
      throw new Error("Compose project/service ownership labels are missing or invalid.");
    // These verbs act on existing label-selected containers; they do not create/reconcile services.
    // A minimal model avoids dependencies on deleted worktrees, secrets, .env files and old overrides.
    const model = JSON.stringify({ services: { [owner.service]: { image: "scratch" } } });
    command = {
      file: "docker",
      cwd: "/",
      stdin: model,
      env: { COMPOSE_DISABLE_ENV_FILE: "true", COMPOSE_ENV_FILES: undefined },
      args: [
        "compose",
        "--project-name",
        owner.project,
        "--file",
        "-",
        verb,
        ...(logs
          ? ["--no-color", "--tail", "150", "--since", "30m"]
          : verb === "restart"
            ? ["--no-deps"]
            : []),
        "--",
        owner.service,
      ],
    };
    scope = `Compose project ${owner.project}, service ${owner.service}, selected by existing container labels. All replicas of this one service; no other services requested. No creation, recreation, pulling or volume removal. Original files are not loaded. Stdin model: ${model} (scratch is a required model placeholder, not an image change).`;
  } else if (owner.kind === "docker") {
    if (!/^[a-f0-9]{12,64}$/.test(owner.id)) throw new Error("Invalid container ID");
    command = {
      file: "docker",
      args: logs
        ? ["logs", "--tail", "150", "--since", "30m", "--timestamps", owner.id]
        : [verb, owner.id],
    };
    scope = `Standalone container ${resource.name} (${owner.id}).`;
  } else throw new Error("Unmanaged process actions are not supported.");
  return {
    target: resource.id,
    scope,
    command: { ...command, timeout: logs ? 15000 : 60000, limit: 128 * 1024 },
    destructive: !logs,
    refresh: logs ? "none" : "resources",
    resourceId: resource.id,
    verb,
  };
}
export const cleanupPreview: Command = {
  file: "docker",
  args: ["system", "df", "--verbose"],
  timeout: 30000,
  limit: 256 * 1024,
};
export function cleanupAction(): Action {
  return {
    target: "Docker daemon's default builder cache",
    scope:
      "Remove dangling default-builder cache older than 168 hours. Docker decides eligibility at execution time; preview is an inventory, not an exact dry run. Volumes, project files and other cache directories are not selected. Reclaimable bytes are not guaranteed physical savings.",
    command: {
      file: "docker",
      args: ["builder", "prune", "--filter", "until=168h", "--force"],
      timeout: 120000,
      limit: 256 * 1024,
    },
    destructive: true,
    refresh: "storage",
  };
}
export function openAction(site: Site): Action {
  return {
    target: site.id,
    scope: `Open ${safeUrl(site.url)} using the OS URL handler.`,
    command: { file: "xdg-open", args: [safeUrl(site.url)], timeout: 10000 },
    destructive: false,
    refresh: "none",
  };
}
export function httpCommand(site: Site): Command {
  return {
    file: "curl",
    args: [
      "-q",
      "--silent",
      "--show-error",
      "--head",
      "--output",
      "/dev/null",
      "--write-out",
      "%{http_code}",
      "--connect-timeout",
      "3",
      "--max-time",
      "6",
      "--max-redirs",
      "0",
      "--proto",
      "=http,https",
      "--noproxy",
      "*",
      "--url",
      safeUrl(site.url),
    ],
    timeout: 8000,
    limit: 8192,
  };
}
export async function executeAction(
  action: Action,
  confirmed: boolean,
  runner: Runner,
  signal?: AbortSignal,
): Promise<Result> {
  if (action.destructive && !confirmed)
    throw new Error("Confirmation required for this exact action");
  return runner(action.command, signal);
}
