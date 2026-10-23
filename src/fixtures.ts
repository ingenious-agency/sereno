import { Store } from "./store.ts";
import type { Config, Resource } from "./model.ts";

export function fixtureStore() {
  const config: Config = {
    projectRoots: ["/fixtures/projects"],
    mappings: [],
    sites: [],
    encargado: { enabled: false },
  };
  const store = new Store(config, async () => {
    throw new Error("Fixture execution disabled");
  });
  const at = Date.now();
  store.projects = {
    state: "ready",
    at,
    data: [
      {
        id: "/fixtures/projects/atlas",
        name: "atlas",
        path: "/fixtures/projects/atlas",
        git: "repository",
        worktrees: ["/fixtures/worktrees/atlas-fix"],
      },
      {
        id: "/fixtures/projects/beacon",
        name: "beacon",
        path: "/fixtures/projects/beacon",
        git: "repository",
        worktrees: [],
      },
    ],
  };
  const resource: Resource = {
    id: `container:${"a".repeat(64)}`,
    kind: "container",
    name: "atlas-web-1",
    status: "running",
    paths: ["/fixtures/worktrees/atlas-fix"],
    ports: ["127.0.0.1:3000->3000/tcp"],
    associations: [],
    related: [],
    cpu: "1.2% (Docker current)",
    memory: "92 MiB / 8 GiB",
    metadata: { image: "example/web:latest" },
    owner: {
      kind: "compose",
      id: "a".repeat(64),
      project: "atlas",
      service: "web",
      directory: "/fixtures/worktrees/atlas-fix",
      files: ["/fixtures/worktrees/atlas-fix/compose.yml"],
    },
  };
  const stopped: Resource = {
    ...resource,
    id: `container:${"b".repeat(64)}`,
    name: "beacon-web",
    status: "exited",
    paths: ["/fixtures/projects/beacon"],
    ports: [],
    owner: { kind: "docker", id: "b".repeat(64) },
  };
  const database: Resource = {
    ...resource,
    id: `container:${"c".repeat(64)}`,
    name: "shared-postgres",
    paths: [],
    ports: ["127.0.0.1:5432->5432/tcp"],
    metadata: { image: "postgres:17" },
    owner: { kind: "docker", id: "c".repeat(64) },
  };
  config.mappings.push({
    resource: database.id,
    projects: store.projects.data.map((p) => p.id),
    relationships: store.projects.data.map((p) => ({
      project: p.id,
      role: "dependency",
      purpose: `Stores ${p.name}'s application data`,
    })),
  });
  store.sources.Docker = { state: "ready", at, data: [resource, stopped, database] };
  for (const key of ["System services", "User services", "Processes", "Listeners"])
    store.sources[key] = {
      state: "unavailable",
      data: [],
      message: "Fixture: permission denied / command unavailable",
      at,
    };
  store.reassociate();
  store.overview = {
    state: "ready",
    at,
    data: {
      hostname: "fixture-server",
      os: "Fixture Linux",
      kernel: "6.x",
      uptime: 123456,
      cpu: "Example CPU",
      threads: 8,
      cores: 4,
      utilization: 12.4,
      load: [0.42, 0.31, 0.2],
      memory: {
        total: 8 * 1024 ** 3,
        used: 3 * 1024 ** 3,
        available: 5 * 1024 ** 3,
        swapTotal: 2 * 1024 ** 3,
        swapUsed: 0,
      },
      temperatures: [],
    },
  };
  store.disks = {
    state: "ready",
    at,
    data: [
      {
        id: "fixture-btrfs",
        source: "/dev/fixture",
        mounts: ["/", "/home"],
        type: "btrfs",
        total: 500 * 1024 ** 3,
        used: 120 * 1024 ** 3,
        available: 380 * 1024 ** 3,
      },
    ],
  };
  store.sites = {
    state: "ready",
    at,
    data: [
      {
        id: "site:fixture",
        url: "https://atlas.example.test/",
        scope: "tailnet",
        source: "fixture Tailscale",
        backend: "http://127.0.0.1:3000",
        chain: ["Tailscale", "127.0.0.1:3000"],
        configured: true,
        availability: "container running; listener unverified",
        associations: store.resources[0].associations,
        resourceIds: [resource.id],
        check: { at, status: 302 },
      },
    ],
  };
  store.rebuildTree();
  return store;
}
