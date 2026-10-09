/** Sereno's domain. Providers and the terminal depend on this module. */
export interface CommandSpec { file: string; args: string[]; cwd?: string; timeout?: number; limit?: number; stdin?: string; env?: Record<string, string | undefined> }
export type Execution = { type: "command"; command: CommandSpec } | { type: "provider"; provider: string; operation: string; target: Record<string, string> };
export interface Action { id: string; label: string; description: string; confirm: boolean; execution: Execution }
export interface NodeBase { id: string; name: string; parent: string | null; labels: string[]; description?: string; actions: Action[]; source: string; aliases?: string[] }
export interface Group extends NodeBase { kind: "group"; details: Record<string, string> }
export interface Resource extends NodeBase {
  kind: "resource"; type: string; status: string; available: boolean;
  details: Record<string, string>; bindings: string[]; observedAt?: number; probe?: CommandSpec;
}
export type Node = Group | Resource;
export interface ProviderSnapshot { id: string; state: "ready" | "partial" | "unavailable"; nodes: Node[]; at?: number; message?: string }
export interface Placement { resource: string; group: string | null; name?: string; labels?: string[]; actions?: Action[] }
export interface Organization { version: 1; groups: Group[]; resources: Resource[]; placements: Placement[] }
export interface Tree { nodes: Record<string, Node>; sources: ProviderSnapshot[] }
export const emptyOrganization = (): Organization => ({ version: 1, groups: [], resources: [], placements: [] });
export const emptyTree = (): Tree => ({ nodes: Object.create(null), sources: [] });
export const ungrouped: Group = { id: "ungrouped", name: "Ungrouped", kind: "group", parent: null, labels: [], actions: [], source: "sereno", details: {} };
export const children = (tree: Tree, parent: string | null): Node[] => Object.values(tree.nodes).filter(n => n.parent === parent).sort((a, b) => a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "group" ? -1 : 1);
export function validateOrganization(organization: Organization) {
  const ids = new Set<string>();
  for (const node of [...organization.groups, ...organization.resources]) {
    if (!node.id.trim() || !node.name.trim()) throw new Error("Node IDs and names must not be empty");
    if (ids.has(node.id) || node.id === "ungrouped") throw new Error(`Duplicate or reserved node ID: ${node.id}`);
    ids.add(node.id);
  }
  const groups = new Map(organization.groups.map(g => [g.id, g]));
  for (const group of organization.groups) {
    const seen = new Set([group.id]); let parent = group.parent;
    while (parent && groups.has(parent)) {
      if (seen.has(parent)) throw new Error(`Group cycle: ${group.id}`);
      seen.add(parent); parent = groups.get(parent)!.parent;
    }
  }
  const placements = new Set<string>();
  for (const placement of organization.placements) {
    if (placements.has(placement.resource)) throw new Error(`Duplicate placement: ${placement.resource}`);
    placements.add(placement.resource);
  }
}
/** One tree, one primary parent per node. Imported facts are enriched by saved organization. */
export function buildTree(sources: ProviderSnapshot[], organization: Organization): Tree {
  validateOrganization(organization);
  const nodes: Record<string, Node> = Object.create(null);
  const aliases = new Map<string, string>();
  const canonicalId = (id: string): string => {
    const seen = new Set<string>();
    while (aliases.has(id)) { if (seen.has(id)) throw new Error(`Identity alias cycle: ${id}`); seen.add(id); id = aliases.get(id)!; }
    return id;
  };
  for (const source of sources) for (const node of source.nodes) {
    if (nodes[node.id]) throw new Error(`Provider node ID collision: ${node.id}`);
    nodes[node.id] = node.kind === "resource" ? { ...node, available: node.available && source.state !== "unavailable", status: source.state === "unavailable" ? "unavailable (last observed: " + node.status + ")" : node.status } : node;
    for (const alias of node.aliases ?? []) aliases.set(alias, node.id);
  }
  for (const [alias, id] of aliases) if (alias !== id) delete nodes[alias];
  // Exact runtime bindings join host observations to an integration's logical resource.
  const managed = Object.values(nodes).filter((n): n is Resource => n.kind === "resource" && n.source !== "host" && n.bindings.length > 0);
  for (const node of Object.values(nodes)) {
    if (node.kind !== "resource" || node.source !== "host") continue;
    const matches = managed.filter(m => m.bindings.some(b => node.bindings.includes(b)));
    if (matches.length === 1) {
      const owner = matches[0];
      nodes[owner.id] = { ...nodes[owner.id] as Resource, aliases: [...new Set([...(nodes[owner.id].aliases ?? []), node.id, ...(node.aliases ?? [])])], details: { ...nodes[owner.id].details, [`runtime:${node.id}`]: `${node.name} · ${node.status}`, ...Object.fromEntries(Object.entries(node.details).filter(([k]) => ["CPU", "Memory"].includes(k))) } };
      delete nodes[node.id];
      aliases.set(node.id, owner.id);
    }
  }
  for (const node of [...organization.groups, ...organization.resources]) {
    if (nodes[node.id] && nodes[node.id].source !== "config") throw new Error(`Configured node conflicts with provider: ${node.id}`);
    nodes[node.id] = nodes[node.id] ?? node;
  }
  nodes.ungrouped = { ...ungrouped };
  for (const placement of organization.placements) {
    const node = nodes[canonicalId(placement.resource)]; if (!node) continue;
    nodes[node.id] = { ...node, parent: placement.group ? canonicalId(placement.group) : node.kind === "group" ? null : "ungrouped", ...(placement.name === undefined ? {} : { name: placement.name }), ...(placement.labels === undefined ? {} : { labels: placement.labels }), ...(placement.actions === undefined ? {} : { actions: placement.actions }) };
  }
  for (const node of Object.values(nodes)) {
    if (node.parent && aliases.has(node.parent)) nodes[node.id] = { ...nodes[node.id], parent: canonicalId(node.parent) };
    if (nodes[node.id].parent && nodes[nodes[node.id].parent!]?.kind !== "group") nodes[node.id] = { ...nodes[node.id], parent: node.id === "ungrouped" ? null : "ungrouped" };
    if (node.kind === "resource" && !node.parent) nodes[node.id] = { ...nodes[node.id], parent: "ungrouped" };
  }
  for (const node of Object.values(nodes)) {
    const seen = new Set([node.id]); let parent = node.parent;
    while (parent) { if (seen.has(parent)) throw new Error(`Group cycle: ${node.id}`); seen.add(parent); parent = nodes[parent]?.parent ?? null; }
  }
  return { nodes, sources };
}
export interface ActionPlan { nodeId: string; action: Action; fingerprint: string }
export function planAction(tree: Tree, nodeId: string, actionId: string): ActionPlan {
  const node = tree.nodes[nodeId]; if (!node) throw new Error("Resource or group no longer exists");
  const action = node.actions.find(a => a.id === actionId); if (!action) throw new Error("Action is not available for this resource or group");
  if (node.kind === "resource" && !node.available) throw new Error("Resource information is unavailable; refresh before acting");
  if (action.execution.type === "provider") {
    const execution = action.execution;
    const provider = tree.sources.find(s => s.id === execution.provider);
    if (!provider || provider.state === "unavailable") throw new Error("Provider unavailable; refresh before acting");
  }
  return { nodeId, action, fingerprint: JSON.stringify({ nodeId, action }) };
}
