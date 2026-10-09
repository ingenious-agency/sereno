import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { projectState, roleFor } from "../src/project-state.ts";
import { planProjectStop, executeProjectStop } from "../src/project-stop.ts";
import {
  planProjectStart,
  executeProjectStart,
  resumeRecord,
  loadResume,
  saveResume,
} from "../src/project-start.ts";
import { loadConfig, saveMapping } from "../src/config.ts";
import { associate } from "../src/associations.ts";
import type { Config, Resource, Slice } from "../src/model.ts";

const project = "/projects/alpha";
const container = (id = "a", status = "running"): Resource => ({
  id: `container:${id.repeat(64)}`,
  name: `${id}-web`,
  kind: "container",
  status,
  paths: [project],
  ports: [],
  related: [],
  owner: { kind: "docker", id: id.repeat(64) },
  associations: [{ project, state: "Assigned", reason: "mapping" }],
  metadata: {
    collectionState: "ready",
    collectedAt: new Date().toISOString(),
    image: "example/web:1",
  },
});
const processResource = (): Resource => ({
  ...container(),
  id: "process:900001",
  kind: "process",
  name: "node",
  pid: 900001,
  owner: undefined,
  ports: ["127.0.0.1:3000"],
  metadata: {
    ...container().metadata,
    uid: String(process.getuid?.()),
    startTicks: "12345",
    cgroup: "0::/user.slice/session.scope",
    ppid: "1",
  },
});
const ok = { stdout: "", stderr: "", code: 0, duration: 0, truncated: false };

test("stopped workloads remain stopped with shared resources, single-project dependencies and tooling still running", () => {
  const app = container("a", "exited"),
    database = container("b"),
    proxy = container("c"),
    editor = processResource();
  database.associations[0].role = "dependency";
  proxy.associations.push({ project: "/projects/beta", state: "Assigned", reason: "shared" });
  editor.name = "zed";
  const state = projectState(project, [app, database, proxy, editor]);
  assert.equal(state.status, "Stopped");
  assert.equal(state.stopped, 1);
  assert.equal(state.dependencies.length, 2);
  assert.equal(state.tooling.length, 1);
  assert.equal(planProjectStop(project, [app, database, proxy, editor]).targets.length, 0);
  app.status = "running";
  assert.equal(projectState(project, [app, database, proxy, editor]).status, "Running");
  assert.equal(planProjectStop(project, [app, database, proxy, editor]).targets.length, 1);
});

test("observed workload state distinguishes partial, unknown and no workloads; children do not inflate workloads", () => {
  const app = container(),
    stopped = container("b", "exited"),
    child = processResource();
  child.metadata.container = app.id;
  assert.equal(projectState(project, [app, stopped, child]).status, "Partially running");
  assert.equal(projectState(project, [app, stopped, child]).running, 1);
  app.metadata.collectionState = "unavailable";
  assert.equal(projectState(project, [app, stopped]).status, "Unknown");
  assert.equal(projectState(project, []).status, "No workloads identified");
  app.associations[0].role = "dependency";
  assert.equal(roleFor(child, project, [app, child]), "dependency");
  assert.equal(projectState(project, [app, child]).status, "No workloads identified");
});

test("stopped development servers survive discovery disappearance; respawn is visible and collector loss is unknown", () => {
  const server = processResource();
  const sources: Record<string, Slice<Resource[]>> = {
    Processes: { state: "partial", at: Date.now(), data: [] },
  };
  assert.equal(projectState(project, [], [server], sources).status, "Stopped");
  sources.Processes.state = "unavailable";
  assert.equal(projectState(project, [], [server], sources).status, "Unknown");
  const respawn = { ...server, id: "process:900002", pid: 900002 };
  assert.equal(projectState(project, [respawn], [server], sources).status, "Running");
  const records = [resumeRecord(project, planProjectStop(project, [server]).targets[0], [server])];
  const plan = planProjectStart(project, [], [], records);
  assert.equal(plan.targets.length, 0);
  assert.match(plan.skipped[0].reason, /Manual start/);
});

test("explicit child lifecycle roles cannot be hidden or stopped through their owner", () => {
  const app = container(),
    child = processResource();
  child.metadata.container = app.id;
  child.associations[0].role = "dependency";
  assert.equal(planProjectStop(project, [app, child]).targets.length, 0);
  child.associations[0].role = "workload";
  app.associations[0].role = "dependency";
  assert.equal(projectState(project, [app, child]).running, 1);
  assert.equal(planProjectStop(project, [app, child]).targets.length, 0);
});

test("resume is durable and restores only recorded workloads, databases first, without touching dependencies", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sereno-resume-"));
  try {
    const app = container(),
      database = container("b"),
      alreadyOff = container("c", "exited"),
      shared = container("d");
    database.metadata.image = "postgres:17";
    shared.associations[0].role = "dependency";
    const resources = [app, database, alreadyOff, shared];
    const stop = planProjectStop(project, resources);
    const records = stop.targets.map((t) => resumeRecord(project, t, resources));
    const path = join(directory, "history.json");
    await saveResume(path, records);
    app.status = database.status = "exited";
    const loaded = await loadResume(path),
      plan = planProjectStart(project, resources, [], loaded);
    assert.deepEqual(
      plan.targets.map((t) => t.resources[0]),
      [database.id, app.id],
    );
    const commands: string[][] = [];
    await executeProjectStart(
      plan,
      true,
      async () => ({ resources, sites: [] }),
      loaded,
      async (c) => {
        commands.push(c.args);
        return ok;
      },
      new AbortController().signal,
    );
    assert.deepEqual(commands, [
      ["start", database.owner!.id],
      ["start", app.owner!.id],
    ]);
    assert.equal(alreadyOff.status, "exited");
    assert.equal(shared.status, "running");
    assert.deepEqual(await loadResume(join(directory, "missing.json")), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("resume refuses changed ownership, new Compose replicas, reclassified workloads and unavailable state", () => {
  const app = container();
  app.owner = { kind: "compose", id: app.owner!.id, project: "alpha", service: "web" };
  const records = planProjectStop(project, [app]).targets.map((t) =>
    resumeRecord(project, t, [app]),
  );
  app.status = "exited";
  assert.equal(planProjectStart(project, [app], [], records).targets.length, 1);
  const replica = container("b", "exited");
  replica.owner = { ...app.owner, id: replica.owner!.id };
  assert.equal(planProjectStart(project, [app, replica], [], records).targets.length, 0);
  app.associations = [{ project, state: "Assigned", reason: "updated", role: "dependency" }];
  assert.equal(planProjectStart(project, [app], [], records).targets.length, 0);
  app.associations[0].role = "workload";
  app.metadata.collectionState = "unavailable";
  assert.equal(planProjectStart(project, [app], [], records).targets.length, 0);
  app.metadata.collectionState = "ready";
  app.owner = { ...app.owner, service: "other" };
  assert.equal(planProjectStart(project, [app], [], records).targets.length, 0);
});

test("start executor confirms, revalidates and stops on failure or cancellation", async () => {
  const resources = [container(), container("b")];
  const records = planProjectStop(project, resources).targets.map((t) =>
    resumeRecord(project, t, resources),
  );
  resources.forEach((r) => (r.status = "exited"));
  const plan = planProjectStart(project, resources, [], records);
  let calls = 0;
  const runner = async () => {
    calls++;
    return { ...ok, code: 1 };
  };
  const refresh = async () => ({ resources, sites: [] });
  await assert.rejects(
    executeProjectStart(plan, false, refresh, records, runner, new AbortController().signal),
    /confirmation/,
  );
  assert.equal(calls, 0);
  assert.match(
    (await executeProjectStart(plan, true, refresh, records, runner, new AbortController().signal))
      .stopped,
    /unsuccessful/,
  );
  assert.equal(calls, 1);
  resources[0].associations = [];
  assert.match(
    (await executeProjectStart(plan, true, refresh, records, runner, new AbortController().signal))
      .stopped,
    /scope changed/,
  );
  const controller = new AbortController();
  controller.abort();
  assert.match(
    (await executeProjectStart(plan, true, refresh, records, runner, controller.signal)).stopped,
    /Cancelled/,
  );
  assert.equal(calls, 1);
});

test("resume history is persisted before each stop; write failure prevents that command", async () => {
  const resources = [container(), container("b")],
    plan = planProjectStop(project, resources);
  const order: string[] = [];
  await assert.rejects(
    executeProjectStop(
      plan,
      true,
      async () => ({ resources, sites: [] }),
      async () => {
        order.push("command");
        return ok;
      },
      new AbortController().signal,
      undefined,
      async (target) => {
        order.push("save");
        if (target.resources[0] === resources[1].id) throw new Error("disk full");
      },
    ),
    /disk full/,
  );
  assert.deepEqual(order, ["save", "command", "save"]);
});

test("mapping roles and purposes round-trip, survive ordinary reassignment and propagate to managed children", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sereno-relationships-"));
  try {
    const path = join(directory, "config.json"),
      app = container(),
      child = processResource();
    const config: Config = { projectRoots: ["/projects"], mappings: [], sites: [] };
    await saveMapping(config, app.id, [project], path, [
      { project, role: "dependency", purpose: "Stores application data" },
    ]);
    await saveMapping(config, app.id, [project, "/projects/beta"], path);
    const loaded = await loadConfig(path);
    child.related = [app.id];
    child.metadata.container = app.id;
    const associated = associate([app, child], [], loaded);
    assert.equal(associated[0].associations[0].purpose, "Stores application data");
    assert.equal(roleFor(associated[1], project, associated), "dependency");
    assert.equal(projectState(project, associated).status, "No workloads identified");
    const invalid = JSON.parse(await readFile(path, "utf8"));
    invalid.mappings[0].relationships[0].role = "invalid";
    await writeFile(path, JSON.stringify(invalid));
    await assert.rejects(loadConfig(path), /Invalid mapping relationship/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
