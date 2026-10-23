import { test } from "node:test";
import assert from "node:assert/strict";
import { Effect, Layer, ManagedRuntime } from "effect";
import {
  Application,
  ApplicationLive,
  ApplicationError,
  ActionExecutor,
  InventoryProviders,
  OrganizationRepository,
} from "../src/application.ts";
import { decodeOrganization } from "../src/domain-schema.ts";
import {
  emptyOrganization,
  type Organization,
  type ProviderSnapshot,
  type Execution,
} from "../src/domain.ts";

function setup() {
  let organization = decodeOrganization({
    version: 1,
    groups: [{ id: "work", name: "Work" }],
    resources: [
      {
        id: "worker",
        name: "Worker",
        parent: "work",
        actions: [
          {
            id: "start",
            label: "Start",
            execution: { type: "command", command: { file: "worker", args: ["start"] } },
          },
        ],
      },
    ],
    placements: [],
  });
  let unavailable = false,
    writeFailure = false;
  const executions: Execution[] = [];
  const runtime = ManagedRuntime.make(
    ApplicationLive.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(InventoryProviders, {
            providers: [
              {
                id: "test",
                read: Effect.suspend(() =>
                  unavailable
                    ? Effect.fail(new ApplicationError({ message: "offline" }))
                    : Effect.succeed({
                        id: "test",
                        state: "ready",
                        nodes: [organization.resources[0]],
                      } satisfies ProviderSnapshot),
                ),
              },
            ],
          }),
          Layer.succeed(OrganizationRepository, {
            load: Effect.sync(() => organization),
            save: (next) =>
              writeFailure
                ? Effect.fail(new ApplicationError({ message: "disk full" }))
                : Effect.sync(() => {
                    organization = next;
                  }),
          }),
          Layer.succeed(ActionExecutor, {
            execute: (execution) =>
              Effect.sync(() => {
                executions.push(execution);
                return { text: "done", successful: true };
              }),
          }),
        ),
      ),
    ),
  );
  const run = <A, E>(f: (app: Application["Service"]) => Effect.Effect<A, E>) =>
    runtime.runPromise(Effect.flatMap(Application, f));
  return {
    run,
    runtime,
    executions,
    offline: () => {
      unavailable = true;
    },
    failWrites: () => {
      writeFailure = true;
    },
    organization: () => organization,
  };
}

test("application requires confirmation and rechecks the action before executing", async () => {
  const app = setup();
  try {
    const plan = await app.run((a) => a.preview("worker", "start"));
    await assert.rejects(
      app.run((a) => a.execute(plan, false)),
      /Confirmation/,
    );
    assert.equal(app.executions.length, 0);
    await app.run((a) => a.execute(plan, true));
    assert.equal(app.executions.length, 1);
    await app.run((a) =>
      a.organize((org) => ({
        ...org,
        placements: [
          {
            resource: "worker",
            group: "work",
            actions: [
              {
                ...plan.action,
                execution: { type: "command", command: { file: "other-worker", args: ["start"] } },
              },
            ],
          },
        ],
      })),
    );
    await assert.rejects(
      app.run((a) => a.execute(plan, true)),
      /changed/,
    );
    assert.equal(app.executions.length, 1);
  } finally {
    await app.runtime.dispose();
  }
});

test("organization changes are serialized and failed persistence leaves the displayed tree intact", async () => {
  const app = setup();
  try {
    await app.run((a) => a.refresh);
    await Promise.all([
      app.run((a) =>
        a.organize((org) => ({
          ...org,
          groups: [...org.groups, { ...org.groups[0], id: "one", name: "One" }],
        })),
      ),
      app.run((a) =>
        a.organize((org) => ({
          ...org,
          groups: [...org.groups, { ...org.groups[0], id: "two", name: "Two" }],
        })),
      ),
    ]);
    assert.equal(app.organization().groups.length, 3);
    app.failWrites();
    await assert.rejects(
      app.run((a) =>
        a.organize((org) => ({
          ...org,
          placements: [{ resource: "worker", group: "one", name: "Renamed" }],
        })),
      ),
      /disk full/,
    );
    assert.equal((await app.run((a) => a.snapshot)).nodes.worker.name, "Worker");
    await assert.rejects(
      app.run((a) =>
        a.organize((org) => ({ ...org, placements: [{ resource: "work", group: "work" }] })),
      ),
      /cycle/,
    );
  } finally {
    await app.runtime.dispose();
  }
});

test("failed discovery retains last inventory and blocks execution against unavailable resources", async () => {
  const app = setup();
  try {
    const plan = await app.run((a) => a.preview("worker", "start"));
    app.offline();
    await assert.rejects(
      app.run((a) => a.execute(plan, true)),
      /unavailable/,
    );
    const tree = await app.run((a) => a.snapshot);
    assert.equal(tree.nodes.worker.name, "Worker");
    assert.equal(tree.sources[0].state, "unavailable");
    assert.equal(app.executions.length, 0);
  } finally {
    await app.runtime.dispose();
  }
});
