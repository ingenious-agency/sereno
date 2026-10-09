import { readFile, mkdir, writeFile, rename } from "node:fs/promises";
import { dirname } from "node:path";
import type { Resource, Site } from "./model.ts";
import { resourceAction } from "./actions.ts";
import { activity } from "./project-state.ts";
import { planProjectStop, targetSignature, type StopPlan, type StopTarget, type StopExecution } from "./project-stop.ts";
import { displayCommand, type Runner } from "./runner.ts";

export interface ResumeRecord { project: string; key: string; resources: Resource[]; at: string }
export async function loadResume(path: string): Promise<ResumeRecord[]> {
  let raw: unknown;
  try { raw = JSON.parse(await readFile(path, "utf8")); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return []; throw e; }
  if (!Array.isArray(raw) || raw.some(r => !r || typeof r.project !== "string" || typeof r.key !== "string" || typeof r.at !== "string" || !Array.isArray(r.resources) || r.resources.some((p: Resource) => !p || typeof p.id !== "string" || !Array.isArray(p.associations) || !p.metadata || !Array.isArray(p.ports)))) throw new Error(`Invalid project resume history: ${path}`);
  return raw;
}
export async function saveResume(path: string, records: ResumeRecord[]) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(records, null, 2) + "\n", { mode: 0o600 });
  await rename(temporary, path);
}
export function resumeRecord(project: string, target: StopTarget, resources: Resource[]): ResumeRecord {
  return { project, key: target.key, at: new Date().toISOString(), resources: resources.filter(r => target.resources.includes(r.id)).map(r => ({
    id: r.id, kind: r.kind, name: r.name, status: r.status, owner: r.owner, associations: r.associations,
    paths: r.paths, ports: r.ports, related: [], ...(r.pid ? { pid: r.pid } : {}),
    metadata: Object.fromEntries(["image", "startTicks", "collector", "collectionState", "collectedAt"].filter(k => r.metadata[k] !== undefined).map(k => [k, r.metadata[k]])),
  })) };
}
export function planProjectStart(project: string, resources: Resource[], sites: Site[], records: ResumeRecord[]): StopPlan {
  const plan: StopPlan = { project, targets: [], skipped: [] };
  // Reuse stop's ownership/association checks, independently of current activity.
  const eligible = planProjectStop(project, resources.map(r => ({ ...r, status: r.kind === "container" ? "running" : r.kind === "service" ? "active/running" : r.status })), sites);
  for (const record of records.filter(r => r.project === project)) {
    const skip = (reason: string) => plan.skipped.push({ name: record.resources.map(r => r.name).join(", "), reason });
    if (record.resources.some(r => r.kind === "process")) { skip("Manual start required in the original terminal; no launch recipe is known. Saved PIDs are never restarted."); continue; }
    const current = record.resources.map(saved => resources.find(r => r.id === saved.id));
    if (current.some(r => !r)) { skip("Resource no longer discovered; restore it with its original deployment tool"); continue; }
    if (current.some(r => activity(r!) === "unknown")) { skip("Current state unavailable or stale; refresh first"); continue; }
    if (current.every(r => activity(r!) === "running")) { skip("Already running"); continue; }
    const target = eligible.targets.find(t => t.key === record.key && JSON.stringify(t.resources) === JSON.stringify(record.resources.map(r => r.id).sort()));
    if (!target) { skip("Workload ownership, relationships or owner scope changed; inspect before starting"); continue; }
    const action = resourceAction(current[0]!, "start");
    if (JSON.stringify(action.command) !== JSON.stringify(resourceAction(record.resources[0], "start").command)) { skip("Lifecycle owner changed since stop"); continue; }
    plan.targets.push({ ...target, action });
  }
  // Reverse the stop order: databases before application services.
  const database = (t: StopTarget) => t.resources.some(id => /(?:^|\/)(?:postgres|mysql|mariadb|redis|mongo)(?:[:/]|$)/i.test(resources.find(r => r.id === id)?.metadata.image ?? ""));
  plan.targets.sort((a, b) => Number(database(b)) - Number(database(a)) || a.key.localeCompare(b.key));
  return plan;
}
export function formatStartPlan(plan: StopPlan) {
  return `Project: ${plan.project}\n${plan.targets.length} start command(s) from Sereno's saved resume set. Services already off before project stop are not included.\n\n` +
    plan.targets.map((t, i) => `${i + 1}. ${t.action.target}\nScope: ${t.action.scope}\nCommand: ${displayCommand(t.action.command)}`).join("\n\n") +
    `\n\nNot started:\n${plan.skipped.map(s => `${s.name}: ${s.reason}`).join("\n") || "none"}\n\nShared dependencies keep their independent lifecycle. Commands run sequentially; a failure or changed scope stops the batch. Running does not prove application health.`;
}
export async function executeProjectStart(plan: StopPlan, confirmed: boolean, refresh: () => Promise<{ resources: Resource[]; sites: Site[] }>, records: ResumeRecord[], runner: Runner, signal: AbortSignal, onResult?: (entry: StopExecution) => Promise<void>) {
  if (!confirmed) throw new Error("Project start requires confirmation of the previewed plan");
  const results: StopExecution[] = [];
  for (const target of plan.targets) {
    if (signal.aborted) return { results, stopped: "Cancelled; remaining commands not executed" };
    const snapshot = await refresh();
    const candidate = planProjectStart(plan.project, snapshot.resources, snapshot.sites, records).targets.find(t => t.key === target.key);
    if (signal.aborted) return { results, stopped: "Cancelled; remaining commands not executed" };
    if (!candidate || targetSignature(candidate) !== targetSignature(target)) return { results, stopped: "Target scope changed; preview again. Remaining commands not executed." };
    const result = await runner(target.action.command, signal);
    const entry = { target, result }; results.push(entry);
    await onResult?.(entry);
    if (result.code !== 0 || result.problem || result.truncated) return { results, stopped: "Stopped after unsuccessful command" };
  }
  return { results, stopped: "All previewed commands executed; refreshed state follows" };
}
