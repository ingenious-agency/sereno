import type { Group, Node, Resource as DomainResource, Action, ProviderSnapshot } from "../domain.ts";
import type { Project, Resource, Site } from "../model.ts";
import { resourceAction, openAction, httpCommand } from "../actions.ts";
import { within } from "../associations.ts";

export const projectGroupId = (path: string) => `project:${path}`;
export const checkoutGroupId = (path: string) => `checkout:${path}`;
export const bindingFor = (r: Resource): string | undefined => r.owner?.kind === "compose" ? `compose:${r.owner.project}:${r.owner.service}` : r.owner?.kind === "systemd" ? `systemd:${r.owner.user ? "user" : "system"}:${r.owner.id}` : undefined;
const group = (id: string, name: string, parent: string | null, details: Record<string, string>): Group => ({ id, name, parent, kind: "group", source: "host", labels: [], actions: [], details });
export function hostSnapshot(projects: Project[], resources: Resource[], sites: Site[]): ProviderSnapshot {
  const nodes: Node[] = [], groups = new Set<string>();
  // Worktrees discovered through multiple roots share the same worktree set.
  const canonical = new Map<string, Project>();
  for (const p of projects) { const key = [...new Set([p.path, ...p.worktrees])].sort().join("\0"); if (!canonical.has(key)) canonical.set(key, p); }
  const paths: { path: string; parent: string }[] = [];
  for (const p of canonical.values()) {
    const id = projectGroupId(p.path); groups.add(id); nodes.push(group(id, p.name, null, { Repository: p.path, Git: p.git }));
    for (const path of [...new Set([p.path, ...p.worktrees])]) {
      const checkout = checkoutGroupId(path); groups.add(checkout); paths.push({ path, parent: checkout });
      nodes.push(group(checkout, path === p.path ? "main" : path.split("/").at(-1)!, id, { Path: path }));
    }
  }
  paths.sort((a, b) => b.path.length - a.path.length);
  const parentFor = (r: Resource | Site) => {
    const associations = r.associations.filter(a => a.state !== "Suggested");
    if (associations.length > 1) return "shared";
    if ("paths" in r) { const checkout = paths.find(p => r.paths.some(path => within(path, p.path))); if (checkout) return checkout.parent; }
    return associations.length ? projectGroupId(associations[0].project) : "ungrouped";
  };
  nodes.push(group("shared", "Shared infrastructure", null, {}));
  const logical = new Map<string, DomainResource>();
  for (const r of resources) {
    // Child observations belong to their concrete owner; the owner represents the resource.
    const owner = resources.find(p => p.id === (r.metadata.container ?? r.metadata.systemd));
    if (owner && r.kind === "process") continue;
    if (r.kind === "listener" && r.related.some(id => resources.some(p => p.id === id))) continue;
    const binding = bindingFor(r), id = binding ?? (r.kind === "process" ? `${r.id}:${r.metadata.bootId || "unknown-boot"}:${r.metadata.startTicks || "unknown-start"}` : r.id);
    const previous = logical.get(id);
    if (previous) {
      previous.details[`Runtime ${r.id}`] = `${r.name} · ${r.status}`;
      previous.details[`Runtime state ${r.id}`] = r.status;
      const statuses = [...new Set(Object.entries(previous.details).filter(([key]) => key.startsWith("Runtime state ")).map(([, state]) => state))];
      previous.status = statuses.length === 1 ? statuses[0] : statuses.includes("running") ? "partially running" : "mixed replica states";
      previous.available &&= !["unavailable", "error", "loading"].includes(r.metadata.collectionState);
      continue;
    }
    const actions: Action[] = [];
    const reserved = /^encargado-/.test(r.owner?.project ?? "") || /^encargado(?:-|\.)/.test(r.owner?.id ?? "");
    if (!reserved) for (const verb of ["start", "stop", "restart", "logs"] as const) {
      try { const action = resourceAction(r, verb); actions.push({ id: verb, label: verb[0].toUpperCase() + verb.slice(1), description: action.scope, confirm: action.destructive, execution: { type: "command", command: action.command } }); } catch { /* Unknown types have no inferred lifecycle. */ }
    }
    const available = !["unavailable", "error", "loading"].includes(r.metadata.collectionState) && (!r.metadata.collectedAt || Date.now() - Date.parse(r.metadata.collectedAt) < 60000);
    logical.set(id, { id, aliases: id === r.id || r.kind === "process" ? [] : [r.id], name: r.owner?.kind === "compose" ? `${r.owner.project}/${r.owner.service}` : r.name, parent: parentFor(r), kind: "resource", type: r.kind, source: "host", labels: [], actions, status: r.status, available, bindings: binding ? [binding] : [], details: { ...r.metadata, [`Runtime state ${r.id}`]: r.status, ID: r.id, Ports: r.ports.join(", "), ...(r.cpu ? { CPU: r.cpu } : {}), ...(r.memory ? { Memory: r.memory } : {}), ...(reserved ? { Management: "Encargado; connect its API for actions" } : {}) }, observedAt: Date.parse(r.metadata.collectedAt) || undefined });
  }
  nodes.push(...logical.values());
  for (const s of sites) nodes.push({ id: s.id, name: s.url, parent: parentFor(s), kind: "resource", type: "website", source: "host", labels: [s.scope], status: s.availability, available: true, bindings: [`url:${s.scope}:${s.url}`], details: { URL: s.url, Scope: s.scope, Backend: s.backend ?? "unknown", Chain: s.chain.join(" → "), ...(s.check ? { HTTP: s.check.status === undefined ? s.check.error ?? "unknown" : String(s.check.status) } : {}) }, actions: [
    { id: "open", label: "Open", description: `Open ${s.url}`, confirm: false, execution: { type: "command", command: openAction(s).command } },
    { id: "check", label: "Check HTTP", description: "One HTTP HEAD request; redirects are not followed", confirm: false, execution: { type: "command", command: httpCommand(s) } },
  ] });
  return { id: "host", state: "ready", nodes, at: Date.now() };
}
