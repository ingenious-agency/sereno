import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { Store } from "../src/store.ts";
import { loadConfig } from "../src/config.ts";
import { decodeOrganization } from "../src/domain-schema.ts";
import type { Runner } from "../src/runner.ts";
import { inventory } from "./tree-fixtures.ts";

const fakeHost: Runner = async command => ({ stdout: command.file === "systemctl" ? "[]" : command.file === "tailscale" ? "{}" : "", stderr: "", code: 0, truncated: false, duration: 1 });

test("Unix-socket integration starts the selected service through Encargado and keeps cached groups on daemon loss", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sereno-api-")), socket = join(directory, "control.sock");
  const requests: { path: string; body: unknown }[] = [], data = inventory();
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
    requests.push({ path: req.url!, body });
    if (req.url === "/v1/up") { data.services[1].observed = { state: "running", ready: true }; }
    res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(data));
  });
  server.listen(socket); await once(server, "listening");
  const commands: string[] = [];
  const store = new Store({ projectRoots: [], mappings: [], sites: [], encargado: { socket } }, async c => { commands.push(c.file + " " + c.args.join(" ")); return fakeHost(c); }, join(directory, "config.json"));
  try {
    await store.refreshTree();
    assert.equal(store.tree.nodes["encargado:checkout:w_fix"].name, "fix");
    const plan = await store.previewAction("encargado:service:s_fix", "start");
    assert.equal(requests.filter(r => r.path === "/v1/up").length, 0);
    const result = await store.runAction(plan, true);
    assert.equal(result.successful, true);
    assert.deepEqual(requests.filter(r => r.path === "/v1/up"), [{ path: "/v1/up", body: { path: "/worktrees/fix", service: "web" } }]);
    assert.ok(!commands.some(c => /(?:docker|systemctl).*\b(?:start|stop|restart)\b/.test(c)));
    await new Promise<void>(resolve => server.close(() => resolve()));
    await assert.rejects(store.previewAction("encargado:checkout:w_fix", "stop"), /unavailable/);
    assert.equal(store.tree.sources.find(s => s.id === "encargado")?.state, "unavailable");
    assert.equal(store.tree.nodes["encargado:checkout:w_fix"].name, "fix");
  } finally { store.stop(); server.close(); await rm(directory, { recursive: true, force: true }); }
});

test("nested groups and imported placements persist across a fresh application without storing runtime inventory", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sereno-config-")), path = join(directory, "config.json");
  const config = { projectRoots: [], mappings: [], sites: [], encargado: { enabled: false }, organization: decodeOrganization({ version: 1, groups: [{ id: "infra", name: "Infrastructure" }], resources: [{ id: "custom", name: "Custom", parent: "infra", actions: [] }], placements: [] }) };
  const store = new Store(config, fakeHost, path);
  let reloaded: Store | undefined;
  try {
    await store.refreshTree();
    await store.createGroup("Databases", "infra");
    const child = Object.values(store.tree.nodes).find(n => n.name === "Databases")!;
    await store.place("custom", child.id, "Local database", ["dev"]);
    const written = JSON.parse(await readFile(path, "utf8"));
    assert.equal(written.organization.placements[0].resource, "custom");
    assert.ok(!("tree" in written)); assert.ok(!("sources" in written));
    reloaded = new Store(await loadConfig(path), fakeHost, path); await reloaded.refreshTree();
    assert.equal(reloaded.tree.nodes.custom.parent, child.id); assert.equal(reloaded.tree.nodes.custom.name, "Local database");
    assert.deepEqual(reloaded.tree.nodes.custom.labels, ["dev"]);
    await assert.rejects(store.place("infra", child.id), /cycle/);
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), written);
  } finally { store.stop(); reloaded?.stop(); await rm(directory, { recursive: true, force: true }); }
});

test("custom status probes and lifecycle commands share the tree and start remains possible when stopped", async () => {
  const commands: string[] = [];
  const config = { projectRoots: [], mappings: [], sites: [], encargado: { enabled: false }, organization: decodeOrganization({ version: 1, groups: [], resources: [{ id: "custom", name: "Custom", probe: { file: "custom-status", args: [] }, actions: [{ id: "start", label: "Start", execution: { type: "command", command: { file: "custom-start", args: ["literal argument"] } } }] }], placements: [] }) };
  let running = false;
  const store = new Store(config, async c => {
    commands.push(c.file);
    if (c.file === "custom-status") return { stdout: running ? "running" : "stopped", stderr: "", code: running ? 0 : 1, truncated: false, duration: 1 };
    if (c.file === "custom-start") { assert.deepEqual(c.args, ["literal argument"]); running = true; return { stdout: "started", stderr: "", code: 0, truncated: false, duration: 1 }; }
    return fakeHost(c);
  });
  try {
    await store.refreshTree();
    const plan = await store.previewAction("custom", "start");
    assert.equal(commands.filter(c => c === "custom-start").length, 0);
    assert.equal((store.tree.nodes.custom as import("../src/domain.ts").Resource).status, "stopped");
    await store.runAction(plan, true);
    assert.equal(commands.filter(c => c === "custom-start").length, 1);
    assert.equal((store.tree.nodes.custom as import("../src/domain.ts").Resource).status, "running");
  } finally { store.stop(); }
});
