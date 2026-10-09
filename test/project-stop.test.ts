import { test } from "node:test";
import assert from "node:assert/strict";
import {
  planProjectStop,
  executeProjectStop,
  infrastructure,
  terminateScript,
} from "../src/project-stop.ts";
import { fixtureStore } from "../src/fixtures.ts";
import type { Resource, Site } from "../src/model.ts";
import { run, type Command } from "../src/runner.ts";
import { createTestRenderer } from "@opentui/core/testing";
import { Dashboard } from "../src/ui.ts";
import { installInteractions } from "../src/interactions.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const project = "/projects/alpha";
function container(id: string, extras: Partial<Resource> = {}): Resource {
  return {
    id: `container:${id.repeat(64)}`,
    name: `${id}-web`,
    kind: "container",
    status: "running",
    paths: [project],
    associations: [{ project, state: "Detected", reason: "working directory" }],
    ports: [],
    related: [],
    metadata: {
      collectedAt: new Date().toISOString(),
      collectionState: "ready",
      image: "example/web:1",
    },
    owner: { kind: "docker", id: id.repeat(64) },
    ...extras,
  };
}
function devServer(): Resource {
  return {
    ...container("d"),
    id: "process:900001",
    kind: "process",
    name: "node",
    pid: 900001,
    owner: undefined,
    ports: ["127.0.0.1:3000"],
    metadata: {
      collectedAt: new Date().toISOString(),
      collectionState: "partial",
      uid: String(process.getuid?.()),
      startTicks: "12345",
      cgroup: "0::/user.slice/user-1000.slice/user@1000.service/app.slice/terminal.scope",
      ppid: "900000",
    },
  };
}
function compose(id: string): Resource {
  return container(id, {
    owner: {
      kind: "compose",
      id: id.repeat(64),
      project: "alpha",
      service: "web",
      directory: project,
      files: [project + "/compose.yml"],
    },
  });
}
test("project stop excludes shared, suggested, stale and infrastructure; retains confirmed Kamal app and DB", () => {
  const app = container("a");
  app.metadata.service = "alpha";
  const db = container("b");
  db.metadata.image = "postgres:17";
  const shared = container("c", {
    associations: [
      ...app.associations,
      { project: "/projects/beta", state: "Assigned", reason: "shared" },
    ],
  });
  const suggested = container("d", {
    associations: [{ project, state: "Suggested", reason: "name" }],
  });
  const proxy = container("e");
  proxy.metadata.image = "basecamp/kamal-proxy:v0.9.2";
  const stale = container("f");
  stale.metadata.collectedAt = new Date(Date.now() - 120000).toISOString();
  const plan = planProjectStop(project, [db, proxy, shared, suggested, stale, app]);
  assert.deepEqual(
    plan.targets.map((t) => t.resources[0]),
    [app.id, db.id],
  );
  assert.equal(plan.skipped.length, 4);
  assert.match(plan.targets[0].action.scope, /Kamal/);
  assert.ok(infrastructure({ ...proxy, metadata: { image: "tailscale/tailscale:v1" } }));
});
test("Compose services deduplicate replicas and block the entire owner scope if any replica is shared or unassigned", () => {
  const a = compose("a"),
    b = compose("b");
  let plan = planProjectStop(project, [a, b]);
  assert.equal(plan.targets.length, 1);
  assert.equal(plan.targets[0].resources.length, 2);
  assert.deepEqual(plan.targets[0].action.command.args.slice(-3), ["stop", "--", "web"]);
  b.associations = [];
  plan = planProjectStop(project, [a, b]);
  assert.equal(plan.targets.length, 0);
  assert.match(plan.skipped[0].reason, /Owner scope/);
});
test("confirmed backend use by another project's site blocks a container even when its direct mapping is exclusive", () => {
  const app = container("a");
  const site: Site = {
    id: "site:shared",
    url: "http://test/",
    scope: "localhost",
    source: "manual",
    configured: true,
    availability: "unknown",
    chain: [],
    resourceIds: [app.id],
    associations: [{ project: "/projects/beta", state: "Assigned", reason: "override" }],
  };
  assert.equal(planProjectStop(project, [app], [site]).targets.length, 0);
});
test("only same-user, identified, unmanaged listening processes receive pidfd SIGTERM plans", () => {
  const server = devServer();
  const target = planProjectStop(project, [server]).targets[0];
  assert.equal(target.action.command.file, "python3");
  assert.ok(target.action.command.args.includes("12345"));
  assert.match(target.action.command.args[2], /pidfd_send_signal/);
  assert.match(target.action.scope, /this listening process only/);
  for (const r of [
    { ...server, ports: [] },
    { ...server, pid: process.pid },
    { ...server, metadata: { ...server.metadata, startTicks: "" } },
    { ...server, metadata: { ...server.metadata, uid: "-1" } },
    { ...server, metadata: { ...server.metadata, cgroup: "0::/system.slice/web.service" } },
    { ...server, metadata: { ...server.metadata, container: "container:a" } },
  ])
    assert.equal(planProjectStop(project, [r]).targets.length, 0);
});
test("systemd units with unknown stop propagation or cross-project children are excluded", () => {
  const svc: Resource = {
    ...container("a"),
    kind: "service",
    name: "app.service",
    id: "systemd:user:app.service",
    status: "active/running",
    owner: { kind: "systemd", id: "app.service", user: true },
  };
  assert.equal(planProjectStop(project, [svc]).targets.length, 0);
  svc.metadata.stopPropagationKnown = "yes";
  assert.equal(planProjectStop(project, [svc]).targets.length, 1);
  svc.metadata.stopPropagation = "other.service";
  assert.equal(planProjectStop(project, [svc]).targets.length, 0);
  svc.metadata.stopPropagation = "";
  const p = devServer();
  p.metadata.systemd = svc.id;
  p.associations = [{ project: "/projects/beta", state: "Detected", reason: "cwd" }];
  assert.equal(planProjectStop(project, [svc, p]).targets.length, 0);
});
test("listening language-server child processes are not mistaken for application servers", () => {
  const server = devServer();
  server.name = "beam.smp";
  const parent = {
    ...devServer(),
    id: "process:900000",
    pid: 900000,
    name: "elixir-hex-lens",
    ports: [],
    metadata: { ...server.metadata, ppid: "1" },
  };
  const plan = planProjectStop(project, [server, parent]);
  assert.equal(plan.targets.length, 0);
  assert.match(plan.skipped[0].reason, /language-server/);
  parent.name = "zed-remote-serv";
  assert.equal(planProjectStop(project, [server, parent]).targets.length, 0);
});
test("executor requires confirmation, revalidates scope, and halts remaining commands after failure or cancellation", async () => {
  const resources = [container("a"), container("b")];
  const plan = planProjectStop(project, resources);
  const commands: Command[] = [];
  const runner = async (c: Command) => {
    commands.push(c);
    return { stdout: "", stderr: "mock denial", code: 1, duration: 0, truncated: false };
  };
  const refresh = async () => ({ resources, sites: [] });
  await assert.rejects(
    executeProjectStop(plan, false, refresh, runner, new AbortController().signal),
    /confirmation/,
  );
  assert.equal(commands.length, 0);
  const failed = await executeProjectStop(
    plan,
    true,
    refresh,
    runner,
    new AbortController().signal,
  );
  assert.equal(commands.length, 1);
  assert.match(failed.stopped, /unsuccessful/);
  commands.length = 0;
  resources[0].associations.push({
    project: "/projects/beta",
    state: "Assigned",
    reason: "changed while preview open",
  });
  const changed = await executeProjectStop(
    plan,
    true,
    refresh,
    runner,
    new AbortController().signal,
  );
  assert.equal(commands.length, 0);
  assert.match(changed.stopped, /scope changed/);
  const controller = new AbortController();
  controller.abort();
  assert.match(
    (await executeProjectStop(plan, true, refresh, runner, controller.signal)).stopped,
    /Cancelled/,
  );
});
test("executor refuses new Compose replicas and reused process IDs after preview", async () => {
  const first = compose("a"),
    second = compose("b");
  let calls = 0;
  const runner = async () => {
    calls++;
    return { stdout: "", stderr: "", code: 0, duration: 0, truncated: false };
  };
  const result = await executeProjectStop(
    planProjectStop(project, [first]),
    true,
    async () => ({ resources: [first, second], sites: [] }),
    runner,
    new AbortController().signal,
  );
  assert.match(result.stopped, /scope changed/);
  const server = devServer();
  const plan = planProjectStop(project, [server]);
  server.metadata.startTicks = "99999";
  assert.match(
    (
      await executeProjectStop(
        plan,
        true,
        async () => ({ resources: [server], sites: [] }),
        runner,
        new AbortController().signal,
      )
    ).stopped,
    /scope changed/,
  );
  assert.equal(calls, 0);
});
test("Python helper checks identity and management before SIGTERM (pidfds and signals mocked)", async () => {
  const harness = `import sys, os, signal, io, re
from unittest.mock import patch
script = sys.stdin.read()
uid = os.getuid()
for start, group, expected in [("12345", "0::/user.slice/session.scope", True), ("99999", "0::/user.slice/session.scope", False), ("12345", "0::/system.slice/web.service", False)]:
    files = {"/proc/900001/stat": "900001 (node) " + " ".join(["S"] + ["0"] * 18 + [start]), "/proc/900001/status": f"Uid: {uid} {uid} {uid} {uid}\\n", "/proc/900001/cgroup": group}
    sys.argv = ["helper", "900001", "12345", str(uid), "/work/project"]
    with patch("builtins.open", side_effect=lambda name: io.StringIO(files[name])), patch.object(os, "pidfd_open", return_value=77) as opened, patch.object(os, "close") as closed, patch.object(os, "readlink", return_value="/work/project"), patch.object(signal, "pidfd_send_signal") as sent:
        try:
            exec(script)
        except SystemExit:
            pass
        assert sent.called == expected
        if expected: sent.assert_called_once_with(77, signal.SIGTERM)
        opened.assert_called_once_with(900001)
        closed.assert_called_once_with(77)
print("verified without sending any real signals")
`;
  const result = await run({
    file: "python3",
    args: ["-I", "-c", harness],
    stdin: terminateScript,
  });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /without sending any real signals/);
});
test("groups have no implicit stop action even when their children are running", async () => {
  const setup = await createTestRenderer({ width: 110, height: 30, kittyKeyboard: true });
  const store = fixtureStore();
  let calls = 0;
  store.discoverHost = async () => {};
  store.runner = async () => {
    calls++;
    throw new Error("must not execute");
  };
  const ui = new Dashboard(setup.renderer, store);
  installInteractions(ui);
  ui.section = 1;
  ui.stack = [{ type: "group", id: `project:${store.projects.data[0].id}` }];
  ui.render();
  try {
    setup.mockInput.pressKey("x", { shift: true });
    for (let i = 0; i < 100 && ui.panel?.title !== "Action unavailable"; i++)
      await new Promise((resolve) => setTimeout(resolve, 5));
    assert.match(ui.panel!.text, /Action is not available/);
    assert.equal(ui.panel?.confirm, undefined);
    assert.equal(calls, 0);
  } finally {
    ui.close();
  }
});
