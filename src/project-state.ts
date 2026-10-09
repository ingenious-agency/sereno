import type { Resource, RelationshipRole, Slice } from "./model.ts";

export const confirmedProjects = (r: Resource) => [
  ...new Set(r.associations.filter((a) => a.state !== "Suggested").map((a) => a.project)),
];
export function infrastructure(r: Resource): boolean {
  return (
    /(?:^|\/)(?:kamal-proxy|tailscale|registry)(?:[:/@]|$)/i.test(r.metadata.image ?? "") ||
    /^(?:kamal-proxy|tailscaled|docker-proxy|dockerd|containerd)$/.test(r.name) ||
    /^(?:docker|containerd|kamal-proxy|tailscaled|ssh|sshd|systemd-.+|user@.+)\.service$/.test(
      r.name,
    )
  );
}
export const isTool = (r: Resource) =>
  /(?:language.server|hex-lens|elixir-ls|rust-analyzer|gopls|solargraph|typescript-lang|eslint|vscode|code-insiders|^zed(?:-|$))/i.test(
    r.name,
  );
export function roleFor(r: Resource, project: string, all: Resource[] = []): RelationshipRole {
  const explicit = r.associations.find(
    (a) => a.project === project && a.state !== "Suggested",
  )?.role;
  if (explicit) return explicit;
  const owner = all.find((p) => p.id === (r.metadata.container ?? r.metadata.systemd));
  if (owner && owner !== r) return roleFor(owner, project);
  if (infrastructure(r) || confirmedProjects(r).length > 1) return "dependency";
  if (r.kind === "process") {
    const seen = new Set<string>();
    let parent: Resource | undefined = r;
    while (parent && !seen.has(parent.id)) {
      if (isTool(parent)) return "tooling";
      seen.add(parent.id);
      const pid: number = Number(parent.metadata.ppid);
      parent = all.find((p) => p.kind === "process" && p.pid === pid);
    }
    if (!r.ports.length && !r.metadata.container && !r.metadata.systemd) return "tooling";
  }
  return "workload";
}
export const staleResource = (r: Resource) =>
  ["unavailable", "error", "loading"].includes(r.metadata.collectionState) ||
  !Number.isFinite(Date.parse(r.metadata.collectedAt)) ||
  Date.now() - Date.parse(r.metadata.collectedAt) > 60000;
export function activity(r: Resource): "running" | "stopped" | "unknown" {
  if (staleResource(r)) return "unknown";
  if (r.kind === "container")
    return ["running", "restarting", "paused"].includes(r.status)
      ? "running"
      : ["exited", "created", "dead"].includes(r.status)
        ? "stopped"
        : "unknown";
  if (r.kind === "service")
    return /^(active|activating|reloading|deactivating)\//.test(r.status)
      ? "running"
      : /^(inactive|failed)\//.test(r.status)
        ? "stopped"
        : "unknown";
  return r.status === "running" ? "running" : r.status === "stopped" ? "stopped" : "unknown";
}
export const sourceFor = (r: Resource) =>
  r.kind === "container"
    ? "Docker"
    : r.kind === "service"
      ? r.owner?.user
        ? "User services"
        : "System services"
      : "Processes";
export function projectState(
  project: string,
  resources: Resource[],
  remembered: Resource[] = [],
  sources?: Record<string, Slice<Resource[]>>,
) {
  const associated = resources.filter(
    (r) =>
      r.kind !== "listener" &&
      r.associations.some((a) => a.project === project && a.state !== "Suggested"),
  );
  const workloads = associated.filter(
    (r) =>
      roleFor(r, project, resources) === "workload" &&
      !associated.some(
        (p) =>
          p.id === (r.metadata.container ?? r.metadata.systemd) &&
          roleFor(p, project, resources) === "workload",
      ),
  );
  // Keep stopped unmanaged servers visible after their PIDs disappear. Never revive a saved PID.
  const missing = remembered.filter(
    (r) =>
      r.associations.some((a) => a.project === project && a.state !== "Suggested") &&
      roleFor(r, project, resources) === "workload" &&
      !resources.some(
        (p) =>
          p.id === r.id ||
          (r.kind === "process" &&
            p.kind === "process" &&
            p.name === r.name &&
            p.paths[0] === r.paths[0] &&
            p.associations.some((a) => a.project === project && a.state !== "Suggested")),
      ),
  );
  const states = [
    ...workloads.map(activity),
    ...missing.map((r) => {
      const source = sources?.[sourceFor(r)];
      return r.kind === "process" &&
        source &&
        ["ready", "empty", "partial"].includes(source.state) &&
        source.at &&
        Date.now() - source.at < 60000
        ? "stopped"
        : "unknown";
    }),
  ];
  const running = states.filter((s) => s === "running").length,
    stopped = states.filter((s) => s === "stopped").length;
  const coverage = sources
    ? Object.entries(sources)
        .filter(
          ([, s]) => !["ready", "empty"].includes(s.state) || !s.at || Date.now() - s.at > 60000,
        )
        .map(([name]) => name)
    : [];
  const status = states.includes("unknown")
    ? "Unknown"
    : !states.length
      ? "No workloads identified"
      : running === states.length
        ? "Running"
        : running
          ? "Partially running"
          : "Stopped";
  return {
    status,
    running,
    stopped,
    workloads,
    coverage,
    dependencies: associated.filter((r) => roleFor(r, project, resources) === "dependency"),
    tooling: associated.filter((r) => roleFor(r, project, resources) === "tooling"),
  };
}
