import type { Action } from "./actions.ts";
import { resourceAction } from "./actions.ts";
import type { Resource, Site } from "./model.ts";
import { displayCommand, type Runner, type Result } from "./runner.ts";
import { infrastructure, roleFor } from "./project-state.ts";
export { infrastructure } from "./project-state.ts";

export interface StopTarget { key: string; resources: string[]; action: Action }
export interface StopPlan { project: string; targets: StopTarget[]; skipped: { name: string; reason: string }[] }
const confirmed = (r: Resource) => [...new Set(r.associations.filter(a => a.state !== "Suggested").map(a => a.project))];
const exclusive = (r: Resource, project: string) => confirmed(r).length === 1 && confirmed(r)[0] === project;
const live = (r: Resource) => r.kind === "container" ? ["running", "restarting", "paused"].includes(r.status) : r.kind === "service" ? /^(active|activating|reloading)\//.test(r.status) : r.status === "running";
const stale = (r: Resource) => ["unavailable", "error", "loading"].includes(r.metadata.collectionState) || !r.metadata.collectedAt || Date.now() - Date.parse(r.metadata.collectedAt) > 60000 || !Number.isFinite(Date.parse(r.metadata.collectedAt));

function ownerKey(r: Resource): string {
  const o = r.owner;
  // Compose's actual scope is project+service on the active daemon, not the config file paths.
  if (o?.kind === "compose") return `compose:${o.project}:${o.service}`;
  return o?.kind === "systemd" ? `systemd:${o.user ? "user" : "system"}:${o.id}` : r.id;
}

// pidfd binds the signal to the original process, avoiding a PID-reuse race.
// No process-group signals, forced kills, or watcher/ancestor termination.
export const terminateScript = `import os, signal, sys
pid, start, uid, cwd = int(sys.argv[1]), sys.argv[2], int(sys.argv[3]), sys.argv[4]
if not hasattr(os, "pidfd_open") or not hasattr(signal, "pidfd_send_signal"):
    sys.exit("pidfd support required; no unsafe PID-only fallback")
fd = os.pidfd_open(pid)
try:
    stat = open(f"/proc/{pid}/stat").read().rsplit(")", 1)[1].split()
    status = open(f"/proc/{pid}/status").read().splitlines()
    uids = next(line.split()[1:] for line in status if line.startswith("Uid:"))
    group = open(f"/proc/{pid}/cgroup").read()
    import re
    managed = re.search(r"(?:docker|libpod|kubepods)|/(?!user@)[^/\\n]+\\.service(?:/|$)", group)
    if stat[19] != start or uid != os.getuid() or any(int(u) != uid for u in uids) or os.readlink(f"/proc/{pid}/cwd") != cwd or managed:
        sys.exit("Process identity/ownership changed; refusing to signal")
    signal.pidfd_send_signal(fd, signal.SIGTERM)
    print(f"SIGTERM sent to verified PID {pid}; check refreshed state for exit or respawn")
finally:
    os.close(fd)
`;
function processAction(r: Resource, all: Resource[]): Action {
  if (!r.pid || r.pid <= 1 || !/^\d+$/.test(r.metadata.startTicks) || r.metadata.uid !== String(process.getuid?.()) || !r.paths[0]?.startsWith("/")) throw new Error("Process identity / same-user ownership unavailable");
  if (!r.ports.length) throw new Error("Not a listening development server; not automatically selected");
  if (!r.metadata.cgroup || r.metadata.container || r.metadata.systemd || /(?:docker|libpod|kubepods)|\/(?!user@)[^/\n]+\.service(?:\/|$)/.test(r.metadata.cgroup)) throw new Error("Managed process; use its container or service owner");
  const chain: Resource[] = []; let parent: Resource | undefined = r;
  while (parent && !chain.includes(parent)) { chain.push(parent); const parentId: number = Number(parent.metadata.ppid); parent = all.find(p => p.kind === "process" && p.pid === parentId); }
  if (chain.some(p => /(?:language.server|hex-lens|elixir-ls|rust-analyzer|gopls|solargraph|typescript-lang|eslint|vscode|code-insiders|^zed(?:-|$))/i.test(p.name))) throw new Error("Editor/language-server ancestry; cannot confidently select as an application development server");
  const ancestors = new Set<number>(); let pid: number | undefined = process.pid;
  while (pid && !ancestors.has(pid)) { ancestors.add(pid); pid = Number(all.find(p => p.pid === pid && p.kind === "process")?.metadata.ppid) || undefined; }
  ancestors.add(process.ppid);
  if (ancestors.has(r.pid)) throw new Error("Sereno or its parent session is never a project-stop target");
  return { target: `${r.name} (PID ${r.pid})`, scope: `SIGTERM to this listening process only; ports ${r.ports.join(", ")}; cwd ${r.paths[0]}; UID ${r.metadata.uid}; start ticks ${r.metadata.startTicks}; ancestry ${chain.map(p => `${p.name} (${p.pid})`).join(" ← ")}. Watchers may respawn it.`, command: { file: "python3", args: ["-I", "-c", terminateScript, String(r.pid), r.metadata.startTicks, r.metadata.uid, r.paths[0]], timeout: 8000, limit: 16384 }, destructive: true, refresh: "resources", resourceId: r.id, verb: "stop" };
}

export function planProjectStop(project: string, resources: Resource[], sites: Site[] = []): StopPlan {
  const plan: StopPlan = { project, targets: [], skipped: [] };
  const seen = new Set<string>();
  for (const r of resources.filter(r => r.kind !== "listener" && r.associations.some(a => a.project === project))) {
    const skip = (reason: string) => plan.skipped.push({ name: `${r.name} (${r.id})`, reason });
    if (!exclusive(r, project)) { skip(confirmed(r).length > 1 ? "Shared by multiple projects" : "Suggested only; assign explicitly first"); continue; }
    if (infrastructure(r)) { skip("Shared infrastructure/control plane"); continue; }
    if (roleFor(r, project, resources) !== "workload") { skip(`${roleFor(r, project, resources)} relationship; independent lifecycle (editor/language-server and tooling stay active)`); continue; }
    if (!live(r)) { skip("Already stopped / inactive"); continue; }
    if (stale(r)) { skip("Discovery unavailable or older than 60 seconds; refresh first"); continue; }
    if (r.kind === "process" && (r.metadata.container || r.metadata.systemd)) { skip(`Controlled by ${r.metadata.container ?? r.metadata.systemd}; only its owner may be stopped`); continue; }
    const key = ownerKey(r);
    if (seen.has(key)) continue;
    const scope = r.owner?.kind === "compose" ? resources.filter(p => p.kind === "container" && ownerKey(p) === key) : [r];
    // A Compose command stops every replica, including replicas inferred from another worktree.
    if (scope.some(p => !exclusive(p, project) || infrastructure(p) || stale(p) || roleFor(p, project, resources) !== "workload")) { skip("Owner scope contains shared, unassigned, protected, non-workload or stale resources"); continue; }
    if (sites.some(s => s.resourceIds.some(id => scope.some(p => p.id === id)) && s.associations.some(a => a.state !== "Suggested" && a.project !== project))) { skip("Backend also supports a site belonging to another project"); continue; }
    const children = resources.filter(p => p.kind === "process" && (scope.some(s => p.metadata.container === s.id || p.metadata.systemd === s.id)));
    if (children.some(p => confirmed(p).some(id => id !== project))) { skip("Owner controls a process associated with another project"); continue; }
    if (children.some(p => roleFor(p, project, resources) !== "workload")) { skip("Owner controls a dependency or tooling process with an independent lifecycle; inspect its relationships"); continue; }
    // systemd may propagate stop jobs through dependencies. Only services with a known, empty stop propagation scope qualify.
    if (r.owner?.kind === "systemd" && (r.metadata.stopPropagationKnown !== "yes" || r.metadata.stopPropagation)) { skip("systemd stop propagation is unknown or affects other units; inspect individually"); continue; }
    try {
      const action = r.kind === "process" ? processAction(r, resources) : resourceAction(r, "stop");
      if (r.kind === "process") action.scope += " Manual start required afterwards: no launch recipe is known.";
      if (r.metadata.service && r.owner?.kind === "docker") action.scope += " Kamal-labeled app/accessory container; shared proxy and routes remain configured.";
      plan.targets.push({ key, resources: scope.map(s => s.id).sort(), action }); seen.add(key);
    } catch (e) { skip(String(e)); }
  }
  // App/development processes before databases; deterministic order, not an inferred dependency graph.
  const database = (t: StopTarget) => t.resources.some(id => /(?:^|\/)(?:postgres|mysql|mariadb|redis|mongo)(?:[:/]|$)/i.test(resources.find(r => r.id === id)?.metadata.image ?? ""));
  plan.targets.sort((a, b) => Number(database(a)) - Number(database(b)) || a.key.localeCompare(b.key));
  return plan;
}
export const targetSignature = (t: StopTarget) => JSON.stringify({ key: t.key, ids: t.resources, command: t.action.command });
export function formatStopPlan(plan: StopPlan): string {
  return `Project: ${plan.project}\n${plan.targets.length} owner-scoped stop command(s). Only confirmed, exclusive resources.\n\n` +
    plan.targets.map((t, i) => `${i + 1}. ${t.action.target}\nScope: ${t.action.scope}\nResources: ${t.resources.join(", ")}\nCommand: ${displayCommand(t.action.command)}`).join("\n\n") +
    `\n\nExcluded (${plan.skipped.length}):\n` + plan.skipped.map(s => `${s.name}\n  ${s.reason}`).join("\n") +
    "\n\nNo containers, volumes, files or routes are removed. Commands run sequentially; failure/cancellation stops the remaining commands. There is no rollback.";
}

export interface StopExecution { target: StopTarget; result: Result }
export async function executeProjectStop(plan: StopPlan, confirmedByUser: boolean, refresh: () => Promise<{ resources: Resource[]; sites: Site[] }>, runner: Runner, signal: AbortSignal, onResult?: (entry: StopExecution) => void, beforeStop?: (target: StopTarget, resources: Resource[]) => Promise<void>) {
  if (!confirmedByUser) throw new Error("Project stop requires confirmation of the previewed plan");
  const results: StopExecution[] = [];
  for (const target of plan.targets) {
    if (signal.aborted) return { results, stopped: "Cancelled; remaining commands not executed" };
    const snapshot = await refresh();
    const current = planProjectStop(plan.project, snapshot.resources, snapshot.sites);
    if (signal.aborted) return { results, stopped: "Cancelled; remaining commands not executed" };
    const candidate = current.targets.find(t => t.key === target.key);
    if (!candidate || targetSignature(candidate) !== targetSignature(target)) return { results, stopped: `Target scope changed: ${target.action.target}. Remaining commands not executed; preview again.` };
    await beforeStop?.(target, snapshot.resources);
    if (signal.aborted) return { results, stopped: "Cancelled; remaining commands not executed" };
    const result = await runner(target.action.command, signal);
    const entry = { target, result }; results.push(entry); onResult?.(entry);
    if (result.code !== 0 || result.problem || result.truncated) return { results, stopped: `Stopped after unsuccessful command: ${target.action.target}` };
  }
  return { results, stopped: "All previewed commands executed; refreshed state follows" };
}
