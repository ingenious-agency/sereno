import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Schema } from "effect";
import type { Action, Group, Node, ProviderSnapshot, Resource } from "../domain.ts";
import { redact, safeUrl } from "../runner.ts";
import { projectGroupId, checkoutGroupId } from "./host.ts";

const Owner = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("systemd"), user: Schema.Boolean, unit: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("compose"), project: Schema.String, service: Schema.String }),
]);
export const InventorySchema = Schema.Struct({ version: Schema.Literal(1),
  projects: Schema.Array(Schema.Struct({ id: Schema.String, name: Schema.String, path: Schema.String, gitCommonDir: Schema.String })),
  checkouts: Schema.Array(Schema.Struct({ id: Schema.String, projectId: Schema.String, path: Schema.String, services: Schema.Record(Schema.String, Schema.String) })),
  services: Schema.Array(Schema.Struct({ id: Schema.String, projectId: Schema.String, name: Schema.String, cwd: Schema.String, role: Schema.Literals(["workload", "dependency", "tooling"]), scope: Schema.Literals(["worktree", "project"]), purpose: Schema.optionalKey(Schema.String), consumers: Schema.Array(Schema.String), dependencies: Schema.Array(Schema.String), ports: Schema.Record(Schema.String, Schema.Number), owner: Owner, desired: Schema.Literals(["running", "stopped"]), observed: Schema.Struct({ state: Schema.Literals(["running", "stopped", "failed", "unknown"]), ready: Schema.Boolean, reason: Schema.optionalKey(Schema.String) }), urls: Schema.Array(Schema.Struct({ url: Schema.String, scope: Schema.String, source: Schema.String })), lastError: Schema.optionalKey(Schema.String), routeError: Schema.optionalKey(Schema.String) })),
});
export const defaultSocket = () => process.env.ENCARGADO_SOCKET ?? (process.env.ENCARGADO_HOME ? join(process.env.ENCARGADO_HOME, "control.sock") : join(process.env.XDG_RUNTIME_DIR ?? join(tmpdir(), `encargado-${process.getuid?.()}`), "encargado", "control.sock"));
export function socketRequest(socket: string, method: string, path: string, body?: unknown, signal?: AbortSignal, timeout = 15000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = request({ socketPath: socket, method, path, signal, headers: payload ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {} }, res => {
      const chunks: Buffer[] = []; let size = 0;
      res.on("data", (chunk: Buffer) => { size += chunk.length; if (size > 4 * 1024 * 1024) req.destroy(new Error("Encargado response exceeded limit")); else chunks.push(chunk); });
      res.on("error", reject);
      res.on("end", () => {
        try { const result = JSON.parse(Buffer.concat(chunks).toString()); if ((res.statusCode ?? 500) >= 400) reject(new Error(`Encargado ${res.statusCode}: ${result.error ?? "request failed"}`)); else resolve(result); } catch (error) { reject(error); }
      });
    });
    const timer = setTimeout(() => req.destroy(new Error("Encargado request timed out; refresh to determine its outcome")), timeout);
    req.on("close", () => clearTimeout(timer)); req.on("error", reject); req.end(payload);
  });
}
const group = (id: string, name: string, parent: string | null, details: Record<string, string>, actions: Action[] = []): Group => ({ id, name, parent, details, actions, kind: "group", source: "encargado", labels: [] });
const action = (operation: string, label: string, path: string, service?: string): Action => ({ id: operation, label, description: `${label} through Encargado · checkout ${path}${service ? ` · service ${service}` : " · declared workloads; dependencies retain their own lifecycle"}`, confirm: !["logs", "verify"].includes(operation), execution: { type: "provider", provider: "encargado", operation, target: { path, ...(service ? { service } : {}) } } });
export function encargadoSnapshot(input: unknown): ProviderSnapshot {
  const inventory = Schema.decodeUnknownSync(InventorySchema)(input), nodes: Node[] = [];
  const projectId = (id: string) => `encargado:project:${id}`, checkoutId = (id: string) => `encargado:checkout:${id}`;
  for (const p of inventory.projects) nodes.push({ ...group(projectId(p.id), p.name, null, { Repository: p.path, "Git common directory": p.gitCommonDir }), aliases: [projectGroupId(p.path), ...inventory.checkouts.filter(c => c.projectId === p.id).map(c => projectGroupId(c.path))] });
  for (const c of inventory.checkouts) {
    const p = inventory.projects.find(p => p.id === c.projectId);
    nodes.push({ ...group(checkoutId(c.id), c.path === p?.path ? "main" : c.path.split("/").at(-1)!, projectId(c.projectId), { Path: c.path }, [action("start", "Start", c.path), action("stop", "Stop", c.path)]), aliases: [checkoutGroupId(c.path)] });
  }
  for (const s of inventory.services) {
    const consumer = inventory.checkouts.find(c => s.consumers.includes(c.id));
    let parent = consumer ? checkoutId(consumer.id) : projectId(s.projectId);
    if (s.scope === "project") {
      parent = `${projectId(s.projectId)}:shared`;
      if (!nodes.some(n => n.id === parent)) nodes.push(group(parent, "Shared services", projectId(s.projectId), {}));
    }
    const id = `encargado:service:${s.id}`;
    const resource: Resource = { id, name: s.name, parent, kind: "resource", type: "service", source: "encargado", labels: [s.role], bindings: [s.owner.kind === "systemd" ? `systemd:${s.owner.user ? "user" : "system"}:${s.owner.unit}` : `compose:${s.owner.project}:${s.owner.service}`], status: s.observed.state === "running" ? s.observed.ready ? "running · ready" : "running · not ready" : s.observed.state, available: true, observedAt: Date.now(), details: { Role: s.role, Scope: s.scope, Desired: s.desired, Ready: String(s.observed.ready), Path: s.cwd, Consumers: s.consumers.map(id => inventory.checkouts.find(c => c.id === id)?.path ?? id).join("\n"), Dependencies: s.dependencies.join(", "), Ports: Object.entries(s.ports).map(([name, port]) => `${name}: ${port}`).join(", "), ...(s.purpose ? { Purpose: s.purpose } : {}), ...(s.lastError ? { Error: s.lastError } : {}), ...(s.observed.reason ? { Reason: s.observed.reason } : {}), ...(s.routeError ? { "Route error": s.routeError } : {}) }, actions: consumer ? [action("start", "Start", consumer.path, s.name), action("stop", "Stop", consumer.path, s.name), action("logs", "Logs", consumer.path, s.name), action("verify", "Verify", consumer.path, s.name)] : [] };
    nodes.push(resource);
    for (const u of s.urls) {
      const url = safeUrl(u.url);
      nodes.push({ id: `${id}:url:${url}`, name: url, parent, kind: "resource", type: "website", source: "encargado", labels: [u.scope], status: "registered", available: true, bindings: [`url:${u.scope}:${url}`], details: { URL: url, Service: id, "Backend state": resource.status, Scope: u.scope }, actions: [{ id: "open", label: "Open", description: `Open ${url}`, confirm: false, execution: { type: "command", command: { file: "xdg-open", args: [url], timeout: 10000 } } }, ...(consumer ? [action("verify", "Verify", consumer.path, s.name)] : [])] });
    }
  }
  return { id: "encargado", state: "ready", at: Date.now(), nodes };
}
export async function executeEncargado(socket: string, operation: string, target: Record<string, string>, signal?: AbortSignal) {
  const routes: Record<string, string> = { start: "up", stop: "stop", logs: "logs", verify: "verify" };
  const route = Object.hasOwn(routes, operation) ? routes[operation] : undefined; if (!route || !target.path?.startsWith("/")) throw new Error("Unsupported Encargado action or invalid checkout path");
  const read = operation === "logs" || operation === "verify";
  return socketRequest(socket, read ? "GET" : "POST", `/v1/${route}${read ? "?" + new URLSearchParams(target) : ""}`, read ? undefined : target, signal, read ? 30000 : 180000);
}
export function encargadoOutput(operation: string, result: unknown) {
  let successful = true, message = "";
  if (operation === "verify") {
    const checks = Schema.decodeUnknownSync(Schema.Array(Schema.Struct({ ready: Schema.Boolean })))(result);
    successful = checks.length > 0 && checks.every(check => check.ready);
    if (!successful) message = "Verification did not establish readiness.\n\n";
  } else if (operation === "start" || operation === "stop") {
    const inventory = Schema.decodeUnknownSync(InventorySchema)(result);
    successful = !inventory.services.some(service => service.routeError);
    if (!successful) message = "Local operation completed; Encargado reported routing errors.\n\n";
  }
  return { text: message + redact(JSON.stringify(result, null, 2)), successful };
}
