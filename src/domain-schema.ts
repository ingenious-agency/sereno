import { Schema } from "effect";
import { validateOrganization, type Action, type Organization } from "./domain.ts";

const strings = Schema.Record(Schema.String, Schema.String);
export const CommandSchema = Schema.Struct({ file: Schema.String, args: Schema.Array(Schema.String), cwd: Schema.optionalKey(Schema.String), timeout: Schema.optionalKey(Schema.Number), limit: Schema.optionalKey(Schema.Number), stdin: Schema.optionalKey(Schema.String), env: Schema.optionalKey(Schema.Record(Schema.String, Schema.Union([Schema.String, Schema.Undefined]))) });
const ActionSchema = Schema.Struct({ id: Schema.String, label: Schema.String, description: Schema.optionalKey(Schema.String), confirm: Schema.optionalKey(Schema.Boolean), execution: Schema.Union([
  Schema.Struct({ type: Schema.Literal("command"), command: CommandSchema }),
  Schema.Struct({ type: Schema.Literal("provider"), provider: Schema.String, operation: Schema.String, target: strings }),
]) });
const base = { id: Schema.String, name: Schema.String, parent: Schema.optionalKey(Schema.NullOr(Schema.String)), labels: Schema.optionalKey(Schema.Array(Schema.String)), description: Schema.optionalKey(Schema.String), actions: Schema.optionalKey(Schema.Array(ActionSchema)), details: Schema.optionalKey(strings) };
export const OrganizationSchema = Schema.Struct({ version: Schema.Literal(1), groups: Schema.Array(Schema.Struct(base)), resources: Schema.Array(Schema.Struct({ ...base, type: Schema.optionalKey(Schema.String), probe: Schema.optionalKey(CommandSchema) })), placements: Schema.Array(Schema.Struct({ resource: Schema.String, group: Schema.NullOr(Schema.String), name: Schema.optionalKey(Schema.String), labels: Schema.optionalKey(Schema.Array(Schema.String)), actions: Schema.optionalKey(Schema.Array(ActionSchema)) })) });
export function decodeOrganization(input: unknown): Organization {
  const raw = Schema.decodeUnknownSync(OrganizationSchema)(input);
  const actions = (items: typeof raw.groups[number]["actions"]): Action[] => (items ?? []).map(a => ({ ...a, description: a.description ?? a.label, confirm: a.confirm ?? true, execution: a.execution.type === "command" ? { type: "command", command: { ...a.execution.command, args: [...a.execution.command.args] } } : a.execution }));
  const node = (n: typeof raw.groups[number]) => ({ ...n, parent: n.parent ?? null, labels: [...n.labels ?? []], actions: actions(n.actions), details: n.details ?? {}, source: "config" });
  const organization: Organization = {
    version: 1, groups: raw.groups.map(g => ({ ...node(g), kind: "group" })),
    resources: raw.resources.map(r => ({ ...node(r), kind: "resource", type: r.type ?? "custom", status: "unknown", available: true, bindings: [], ...(r.probe ? { probe: { ...r.probe, args: [...r.probe.args] } } : {}) })),
    placements: raw.placements.map(p => ({ resource: p.resource, group: p.group, ...(p.name === undefined ? {} : { name: p.name }), ...(p.labels === undefined ? {} : { labels: [...p.labels] }), ...(p.actions === undefined ? {} : { actions: actions(p.actions) }) })),
  };
  for (const n of [...organization.groups, ...organization.resources]) {
    if (!n.id.trim() || !n.name.trim()) throw new Error("Node IDs and names must not be empty");
    const seen = new Set<string>();
    for (const a of n.actions) {
      if (!a.id.trim() || seen.has(a.id)) throw new Error(`Duplicate or empty action ID: ${n.id}`); seen.add(a.id);
      if (a.execution.type === "command" && (!a.execution.command.file.trim() || a.execution.command.file.includes("\0"))) throw new Error("Invalid action executable");
      if (a.execution.type === "command") for (const key of ["timeout", "limit"] as const) {
        const value = a.execution.command[key]; if (value !== undefined && (!Number.isFinite(value) || value <= 0)) throw new Error(`Command ${key} must be a positive finite number`);
      }
    }
  }
  validateOrganization(organization); return organization;
}
