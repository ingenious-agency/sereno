import { readFile, readdir, readlink, realpath } from "node:fs/promises";
import { hostname, release, uptime, cpus, loadavg } from "node:os";
import { join } from "node:path";
import { mapLimit, requireOutput, clean, redact, type Runner } from "./runner.ts";
import type { Config, Disk, Overview, Project, Resource } from "./model.ts";

export const jsonLines = <T = any>(text: string): T[] => text.trim() ? text.trim().split("\n").map(line => JSON.parse(line)) : [];
export function parseWorktrees(text: string): string[] { return text.split("\0").filter(x => x.startsWith("worktree ")).map(x => x.slice(9)); }
export function parseProperties(text: string): Record<string, string>[] {
  return text.trim().split(/\n\s*\n/).filter(Boolean).map(block => Object.fromEntries(block.split("\n").map(line => { const i = line.indexOf("="); return [line.slice(0, i), line.slice(i + 1)]; })));
}
export function serviceDirectory(raw: string | undefined): string[] {
  // systemctl may prefix WorkingDirectory with ! (or - for optional paths).
  // Never resolve special/relative values against Sereno's working directory.
  const path = raw?.replace(/^[-!]+/, "");
  return path?.startsWith("/") && path !== "/" ? [path] : [];
}
export async function discoverProjects(config: Config, run: Runner, signal?: AbortSignal): Promise<{ projects: Project[]; issues: string[] }> {
  const projects: Project[] = [], issues: string[] = [];
  for (const root of config.projectRoots) {
    try {
      const entries = await readdir(root, { withFileTypes: true });
      const found = await mapLimit(entries.filter(e => e.isDirectory() || e.isSymbolicLink()), 4, async entry => {
        const path = await realpath(join(root, entry.name));
        const result = await run({ file: "git", args: ["-C", path, "worktree", "list", "--porcelain", "-z"] }, signal);
        return { id: path, name: entry.name, path, worktrees: result.code === 0 && !result.problem ? parseWorktrees(result.stdout) : [], git: result.code === 0 ? "repository" : `unavailable: ${redact(result.problem ?? result.stderr.trim())}` };
      });
      projects.push(...found);
    } catch (e) { issues.push(`${root}: ${redact(String(e))}`); }
  }
  return { projects: [...new Map(projects.map(p => [p.id, p])).values()].sort((a, b) => a.name.localeCompare(b.name)), issues };
}

let previousCpu: { total: number; idle: number } | undefined;
export async function collectOverview(): Promise<Overview> {
  const [os, mem, stat, info] = await Promise.all([readFile("/etc/os-release", "utf8"), readFile("/proc/meminfo", "utf8"), readFile("/proc/stat", "utf8"), readFile("/proc/cpuinfo", "utf8")]);
  const ticks = stat.split("\n")[0].trim().split(/\s+/).slice(1, 9).map(Number);
  const current = { total: ticks.reduce((a, b) => a + b, 0), idle: ticks[3] + ticks[4] };
  const utilization = previousCpu && current.total > previousCpu.total ? 100 * (1 - (current.idle - previousCpu.idle) / (current.total - previousCpu.total)) : undefined;
  previousCpu = current;
  const m = Object.fromEntries([...mem.matchAll(/^(\w+):\s+(\d+)/gm)].map(x => [x[1], Number(x[2]) * 1024]));
  const coreIds = new Set(info.split(/\n\n/).filter(x => /core id\s*:/.test(x)).map(block => `${block.match(/physical id\s*:\s*(\d+)/)?.[1]}:${block.match(/core id\s*:\s*(\d+)/)?.[1]}`));
  const temperatures: string[] = [];
  try {
    for (const dir of await readdir("/sys/class/hwmon")) {
      const base = `/sys/class/hwmon/${dir}`;
      const name = (await readFile(`${base}/name`, "utf8").catch(() => dir)).trim();
      for (const file of (await readdir(base)).filter(x => /^temp\d+_input$/.test(x))) {
        const value = Number(await readFile(`${base}/${file}`, "utf8").catch(() => "NaN"));
        if (Number.isFinite(value)) temperatures.push(`${name} ${(await readFile(`${base}/${file.replace("input", "label")}`, "utf8").catch(() => file)).trim()}: ${(value / 1000).toFixed(1)}°C`);
      }
    }
  } catch { /* Explicit unavailable in view. */ }
  return { hostname: hostname(), os: os.match(/^PRETTY_NAME="?(.*?)"?$/m)?.[1] ?? "unavailable", kernel: release(), uptime: uptime(), cpu: cpus()[0]?.model ?? "unavailable", threads: cpus().length, cores: coreIds.size || undefined, utilization, load: loadavg(), memory: m.MemAvailable === undefined ? undefined : { total: m.MemTotal, available: m.MemAvailable, used: m.MemTotal - m.MemAvailable, swapTotal: m.SwapTotal, swapUsed: m.SwapTotal - m.SwapFree }, temperatures };
}

export function parseDisks(raw: any): Disk[] {
  const disks = new Map<string, Disk>();
  function walk(entries: any[]) { for (const f of entries) {
    if (f.uuid || (String(f.source).startsWith("/dev/") && f.fstype !== "overlay")) {
      const id = f.uuid || String(f.source).replace(/\[.*\]$/, "");
      const number = (v: unknown) => v == null || !Number.isFinite(Number(v)) ? undefined : Number(v);
      if (disks.has(id)) disks.get(id)!.mounts.push(f.target);
      else disks.set(id, { id, source: String(f.source).replace(/\[.*\]$/, ""), mounts: [f.target], type: f.fstype, total: number(f.size), used: number(f.used), available: number(f.avail) });
    }
    walk(f.children ?? []);
  } }
  walk(raw.filesystems ?? []); return [...disks.values()];
}
export async function collectDisks(run: Runner, signal?: AbortSignal) {
  return parseDisks(JSON.parse(requireOutput(await run({ file: "findmnt", args: ["--json", "--bytes", "--output", "TARGET,SOURCE,FSTYPE,SIZE,USED,AVAIL,UUID"] }, signal))));
}

export function parseContainer(raw: any): Resource {
  const labels: Record<string, string> = raw.labels ?? {};
  const directory = labels["com.docker.compose.project.working_dir"];
  const project = labels["com.docker.compose.project"], service = labels["com.docker.compose.service"];
  const compose = Boolean(project && service);
  const metadata: Record<string, string> = { image: raw.image, networkMode: raw.networkMode ?? "unknown" };
  for (const k of ["service", "role", "destination"]) if (labels[k]) metadata[k] = labels[k];
  if (project) metadata["compose.project"] = project;
  const ports: string[] = [];
  for (const [target, bindings] of Object.entries(raw.ports ?? {})) for (const b of (bindings ?? []) as any[]) ports.push(`${b.HostIp}:${b.HostPort}->${target}`);
  for (const network of Object.values(raw.networks ?? {}) as any[]) if (network.IPAddress) metadata[`network.${network.IPAddress}`] = network.IPAddress;
  return { id: `container:${raw.id}`, kind: "container", name: raw.name.replace(/^\//, ""), status: raw.status, paths: directory ? [directory] : [], ports, related: [], associations: [], pid: raw.pid,
    owner: compose ? { kind: "compose", id: raw.id, project, service, directory, files: labels["com.docker.compose.project.config_files"]?.split(",") } : { kind: "docker", id: raw.id }, metadata };
}
export async function collectContainers(run: Runner, signal?: AbortSignal): Promise<{ resources: Resource[]; issues: string[] }> {
  const ids = requireOutput(await run({ file: "docker", args: ["ps", "-aq", "--no-trunc"] }, signal)).trim().split("\n").filter(Boolean);
  if (!ids.length) return { resources: [], issues: [] };
  // A strict projection avoids pulling environment variables, command arguments, or full configs into memory.
  const labelKeys = ["service", "role", "destination", "com.docker.compose.project", "com.docker.compose.service", "com.docker.compose.project.working_dir", "com.docker.compose.project.config_files"];
  const labelFormat = labelKeys.map(key => `${JSON.stringify(key)}:{{json (index .Config.Labels ${JSON.stringify(key)})}}`).join(",");
  const format = '{"id":{{json .Id}},"name":{{json .Name}},"image":{{json .Config.Image}},"labels":{' + labelFormat + '},"networkMode":{{json .HostConfig.NetworkMode}},"status":{{json .State.Status}},"pid":{{json .State.Pid}},"ports":{{json .NetworkSettings.Ports}},"networks":{{json .NetworkSettings.Networks}}}';
  const resources = jsonLines(requireOutput(await run({ file: "docker", args: ["inspect", "--format", format, ...ids], limit: 4 * 1024 * 1024 }, signal))).map(parseContainer);
  const stats = await run({ file: "docker", args: ["stats", "--no-stream", "--format", "{{json .}}"], timeout: 8000 }, signal);
  const issues: string[] = [];
  try {
    for (const s of jsonLines(requireOutput(stats))) {
      const r = resources.find(r => r.owner!.id.startsWith(s.ID));
      if (r) { r.cpu = `${s.CPUPerc} (Docker current)`; r.memory = s.MemUsage; }
    }
  } catch (e) { issues.push(`Container metrics unavailable: ${e}`); }
  return { resources, issues };
}

export async function collectServices(run: Runner, user: boolean, signal?: AbortSignal): Promise<Resource[]> {
  const prefix = user ? ["--user"] : [];
  const units: any[] = JSON.parse(requireOutput(await run({ file: "systemctl", args: [...prefix, "list-units", "--all", "--type=service", "--output=json", "--no-pager"] }, signal)));
  if (!units.length) return [];
  const props = parseProperties(requireOutput(await run({ file: "systemctl", args: [...prefix, "show", "--no-pager", "--property=Id,WorkingDirectory,MainPID,MemoryCurrent,ControlGroup,FragmentPath,RequiredBy,RequisiteOf,BoundBy,ConsistsOf,PropagatesStopTo", "--", ...units.map(u => u.unit)] }, signal)));
  return units.map(u => {
    const p = props.find(p => p.Id === u.unit) ?? {};
    return { id: `systemd:${user ? "user" : "system"}:${u.unit}`, kind: "service", name: u.unit, status: `${u.active}/${u.sub}`, paths: serviceDirectory(p.WorkingDirectory), associations: [], ports: [], related: [], pid: Number(p.MainPID) || undefined,
      memory: /^\d+$/.test(p.MemoryCurrent) && Number(p.MemoryCurrent) < 2 ** 63 ? `${p.MemoryCurrent} bytes (cgroup; overlaps processes)` : undefined,
      owner: { kind: "systemd", id: u.unit, user }, metadata: { scope: user ? "user" : "system", unitFile: p.FragmentPath ?? "unavailable", cgroup: p.ControlGroup ?? "", stopPropagationKnown: ["RequiredBy", "RequisiteOf", "BoundBy", "ConsistsOf", "PropagatesStopTo"].every(key => key in p) ? "yes" : "no", stopPropagation: [p.RequiredBy, p.RequisiteOf, p.BoundBy, p.ConsistsOf, p.PropagatesStopTo].filter(Boolean).join(" ") } };
  });
}
export async function collectProcesses(run: Runner, signal?: AbortSignal): Promise<{ resources: Resource[]; issues: string[] }> {
  const text = requireOutput(await run({ file: "ps", args: ["-eo", "pid=,pcpu=,rss=,comm="], limit: 2 * 1024 * 1024 }, signal));
  let hidden = 0;
  const resources = await mapLimit(text.trim().split("\n").filter(Boolean), 16, async line => {
    const match = line.trim().match(/^(\d+)\s+([\d.]+)\s+(\d+)\s+(.+)$/);
    if (!match) return undefined;
    const pid = Number(match[1]);
    const cwd = await readlink(`/proc/${pid}/cwd`).catch(() => { hidden++; return undefined; });
    const cgroup = await readFile(`/proc/${pid}/cgroup`, "utf8").catch(() => "");
    const stat = await readFile(`/proc/${pid}/stat`, "utf8").catch(() => "");
    const status = await readFile(`/proc/${pid}/status`, "utf8").catch(() => "");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
    return { id: `process:${pid}`, kind: "process", name: clean(match[4]), status: "running", paths: cwd ? [cwd] : [], ports: [], related: [], associations: [], pid, cpu: `${match[2]}% (lifetime average)`, memory: `${Number(match[3]) * 1024} bytes RSS`, metadata: { cgroup: cgroup.trim(), cwd: cwd ?? "unavailable (permissions or process exited)", startTicks: fields[19] ?? "", ppid: fields[1] ?? "", uid: status.match(/^Uid:\s+(\d+)/m)?.[1] ?? "" } } as Resource;
  });
  return { resources: resources.filter((r): r is Resource => Boolean(r)), issues: hidden ? [`${hidden} process working directories unavailable (permissions, kernel threads, or exited processes).`] : [] };
}
export function parseListeners(text: string): Resource[] {
  return text.trim().split("\n").filter(Boolean).map(line => {
    const cols = line.trim().split(/\s+/); const address = cols[3];
    if (!address || !/:\d+$/.test(address)) throw new Error("Unrecognized ss listener output");
    const pids = [...line.matchAll(/pid=(\d+)/g)].map(x => Number(x[1]));
    return { id: `listener:${address}`, kind: "listener", name: address, status: "listening", paths: [], ports: [address], related: pids.map(pid => `process:${pid}`), associations: [], metadata: { visibility: pids.length ? "PID metadata available" : "Owner unavailable (permissions or kernel listener)" } };
  });
}
export async function collectListeners(run: Runner, signal?: AbortSignal) {
  return parseListeners(requireOutput(await run({ file: "ss", args: ["-H", "-ltnp"] }, signal)));
}
export function linkResources(resources: Resource[]): Resource[] {
  for (const process of resources.filter(r => r.kind === "process")) {
    const container = resources.find(r => r.kind === "container" && ((r.pid && r.pid === process.pid) || (process.metadata.cgroup ?? "").includes(r.owner!.id)));
    const service = resources.find(r => r.kind === "service" && ((r.pid && r.pid === process.pid) || (r.metadata.cgroup && (process.metadata.cgroup ?? "").split("\n").some(line => line.endsWith(":" + r.metadata.cgroup)))));
    if (container) { process.related.push(container.id); process.metadata.container = container.id; }
    else if (service) { process.metadata.systemd = service.id; process.related.push(service.id); service.related.push(process.id); }
  }
  for (const listener of resources.filter(r => r.kind === "listener")) for (const id of listener.related) {
    const p = resources.find(r => r.id === id);
    if (p) {
      p.ports.push(...listener.ports);
      for (const related of [...p.related, p.metadata.systemd]) { const owner = resources.find(r => r.id === related); if (owner) owner.ports.push(...listener.ports); }
    }
  }
  return resources;
}
