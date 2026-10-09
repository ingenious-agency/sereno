import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTree, children, emptyOrganization, planAction, type Group, type Resource } from "../src/domain.ts";
import { decodeOrganization } from "../src/domain-schema.ts";
import { encargadoOutput, encargadoSnapshot } from "../src/providers/encargado.ts";
import { hostSnapshot } from "../src/providers/host.ts";
import { fixtureStore } from "../src/fixtures.ts";

import { inventory } from "./tree-fixtures.ts";
const group = (id: string, parent: string | null = null): Group => ({ id, name: id, parent, kind: "group", labels: [], source: "config", details: {}, actions: [] });
const resource = (id: string, parent: string | null = null): Resource => ({ ...group(id, parent), kind: "resource", type: "custom", status: "unknown", available: true, bindings: [] });

test("one tree contains worktrees, shared services, and stopped services with their registered URLs", () => {
  const snapshot = encargadoSnapshot(inventory()), tree = buildTree([snapshot], emptyOrganization());
  assert.equal(children(tree, "encargado:project:p_app").length, 3);
  assert.equal(tree.nodes["encargado:service:s_main"].parent, "encargado:checkout:w_main");
  assert.equal((tree.nodes["encargado:service:s_main"] as Resource).status, "stopped");
  assert.equal((tree.nodes["encargado:service:s_fix"] as Resource).status, "running · not ready");
  assert.equal(Object.values(tree.nodes).filter(n => n.id === "encargado:service:s_db").length, 1);
  assert.equal(Object.values(tree.nodes).filter(n => n.kind === "resource" && n.type === "website").length, 1);
  assert.equal(planAction(tree, "encargado:checkout:w_fix", "stop").action.execution.type, "provider");
});

test("exact ownership merges host resources and project groups, retaining saved organization through aliases", () => {
  const fixture = fixtureStore();
  try {
    const raw = fixture.resources[0];
    raw.owner = { kind: "compose", id: "a".repeat(64), project: "encargado-p-app", service: "db" };
    raw.paths = ["/projects/app"];
    const host = hostSnapshot([{ id: "/projects/app", name: "app", path: "/projects/app", worktrees: ["/worktrees/fix"], git: "repository" }], [raw], []);
    const org = { ...emptyOrganization(), groups: [group("infra")], placements: [{ resource: raw.id, group: "infra", name: "Data store", labels: ["important"] }] };
    const tree = buildTree([host, encargadoSnapshot(inventory())], org);
    assert.equal(tree.nodes["project:/projects/app"], undefined);
    assert.equal(tree.nodes["checkout:/worktrees/fix"], undefined);
    assert.equal(tree.nodes["compose:encargado-p-app:db"], undefined);
    assert.equal(tree.nodes["encargado:service:s_db"].parent, "infra");
    assert.equal(tree.nodes["encargado:service:s_db"].name, "Data store");
    assert.match(tree.nodes["encargado:service:s_db"].details[`runtime:compose:encargado-p-app:db`], /running/);
    assert.deepEqual(tree.nodes["encargado:service:s_db"].labels, ["important"]);
  } finally { fixture.stop(); }
});

test("resources have one parent, unknown parents go to Ungrouped, and cyclic organization is rejected", () => {
  const org = { ...emptyOrganization(), groups: [group("a"), group("b", "a")], resources: [resource("custom", "missing")] };
  const tree = buildTree([], org);
  assert.equal(tree.nodes.custom.parent, "ungrouped");
  assert.equal(children(tree, "a")[0].id, "b");
  assert.throws(() => buildTree([], { ...org, placements: [{ resource: "a", group: "b" }] }), /cycle/);
  assert.throws(() => buildTree([], { ...org, groups: [group("a", "b"), group("b", "a")] }), /cycle/);
  assert.throws(() => buildTree([], { ...org, placements: [{ resource: "custom", group: "a" }, { resource: "custom", group: "b" }] }), /Duplicate placement/);
});

test("configuration validates action structure and defaults custom lifecycle confirmation", () => {
  const org = decodeOrganization({ version: 1, groups: [{ id: "infra", name: "Infrastructure" }], resources: [{ id: "task", name: "Task", parent: "infra", actions: [{ id: "start", label: "Start", execution: { type: "command", command: { file: "task", args: ["start"] } } }] }], placements: [] });
  assert.equal(org.resources[0].actions[0].confirm, true);
  assert.equal(org.resources[0].parent, "infra");
  assert.throws(() => decodeOrganization({ ...org, resources: [{ ...org.resources[0], actions: [{ id: "bad", label: "Bad", execution: { type: "command", command: { file: "task", args: "start" } } }] }] }));
  assert.throws(() => encargadoSnapshot({ ...inventory(), version: 2 }));
});

test("provider outage keeps the tree visible and disables provider actions without inferring replacements", () => {
  const source = encargadoSnapshot(inventory()); source.state = "unavailable";
  const tree = buildTree([source], emptyOrganization());
  assert.match((tree.nodes["encargado:service:s_main"] as Resource).status, /unavailable/);
  assert.throws(() => planAction(tree, "encargado:service:s_main", "start"), /unavailable/);
  assert.throws(() => planAction(tree, "encargado:checkout:w_fix", "stop"), /unavailable/);
});

test("new process identity does not inherit a saved placement after PID reuse", () => {
  const raw = { id: "process:77", kind: "process" as const, name: "worker", status: "running", paths: [], ports: [], related: [], associations: [], metadata: { bootId: "boot", startTicks: "100" } };
  const first = hostSnapshot([], [raw], []).nodes.find(n => n.kind === "resource")!;
  const organization = { ...emptyOrganization(), groups: [group("dev")], placements: [{ resource: first.id, group: "dev", name: "My worker" }] };
  const next = buildTree([hostSnapshot([], [{ ...raw, metadata: { ...raw.metadata, startTicks: "200" } }], [])], organization);
  const process = Object.values(next.nodes).find(n => n.kind === "resource")!;
  assert.equal(process.name, "worker"); assert.equal(process.parent, "ungrouped"); assert.notEqual(process.id, first.id);
});

test("Compose replicas retain one resource and expose mixed observed states", () => {
  const fixture = fixtureStore();
  try {
    const first = fixture.resources[0], second = { ...first, id: "container:" + "d".repeat(64), status: "exited" };
    const snapshot = hostSnapshot(fixture.projects.data, [first, second], []);
    const containers = snapshot.nodes.filter(n => n.kind === "resource");
    assert.equal(containers.length, 1); assert.equal((containers[0] as Resource).status, "partially running");
  } finally { fixture.stop(); }
});

test("successful API transport does not hide failed verification or routing", () => {
  assert.equal(encargadoOutput("verify", [{ ready: false }]).successful, false);
  assert.equal(encargadoOutput("verify", [{ ready: true }]).successful, true);
  const data = inventory();
  const result = encargadoOutput("start", { ...data, services: data.services.map(s => ({ ...s, routeError: "gateway unavailable" })) });
  assert.equal(result.successful, false); assert.match(result.text, /Local operation completed/);
});
