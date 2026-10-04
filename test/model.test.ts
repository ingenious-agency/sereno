import { test } from "node:test";
import assert from "node:assert/strict";
import { associate, uniqueResources, within } from "../src/associations.ts";
import { parseContainer, parseDisks, parseListeners, parseProperties, parseWorktrees, linkResources, serviceDirectory } from "../src/collectors.ts";
import { tailscaleSites, parseKamal, backendResources, associateSites } from "../src/sites.ts";
import { parseDu, scanFolder } from "../src/storage.ts";
import type { Config, Project, Resource } from "../src/model.ts";

const config: Config = { projectRoots: ["/projects"], sites: [], mappings: [] };
const projects: Project[] = ["alpha", "beta"].map(name => ({ id: `/projects/${name}`, path: `/projects/${name}`, name, worktrees: [`/worktrees/${name}`], git: "repository" }));
const resource = (changes: Partial<Resource> = {}): Resource => ({ id: "process:42", kind: "process", name: "worker", status: "running", paths: [], ports: [], related: [], associations: [], metadata: {}, ...changes });

test("systemd special WorkingDirectory prefixes cannot attach desktop services to Sereno's CWD", () => {
  assert.deepEqual(serviceDirectory("!/home/user"), ["/home/user"]);
  assert.deepEqual(serviceDirectory("-/projects/alpha"), ["/projects/alpha"]);
  assert.deepEqual(serviceDirectory("~"), []);
  assert.deepEqual(serviceDirectory("/"), []);
  assert.equal(within("!/home/user", process.cwd()), false);
  assert.equal(within("relative/path", process.cwd()), false);
});

test("associations use worktree metadata and path boundaries, never promote matching names", () => {
  const rs = associate([resource({ paths: ["/worktrees/alpha/apps/web"] }), resource({ id: "named", name: "alpha-db" }), resource({ id: "prefix", paths: ["/projects/alpha-evil"] })], projects, config);
  assert.equal(rs[0].associations[0].state, "Detected");
  assert.equal(rs[1].associations[0].state, "Suggested");
  assert.deepEqual(rs[2].associations, []);
});
test("explicit many-project overrides and empty overrides win; shared resources counted once", () => {
  const rs = associate([resource({ paths: ["/projects/alpha"] })], projects, { ...config, mappings: [{ resource: "process:42", projects: projects.map(p => p.id) }] });
  assert.equal(rs[0].associations.length, 2); assert.ok(rs[0].associations.every(a => a.state === "Assigned"));
  assert.equal(uniqueResources(rs, projects.map(p => p.id)).length, 1);
  assert.deepEqual(associate(rs, projects, { ...config, mappings: [{ resource: "process:42", projects: [] }] })[0].associations, []);
});
test("user-manager parent cgroup does not link unrelated process trees", () => {
  const manager = resource({ id: "systemd:system:user@1000.service", kind: "service", metadata: { cgroup: "/user.slice/user-1000.slice/user@1000.service" } });
  const a = resource({ id: "process:1", paths: ["/projects/alpha"], metadata: { cgroup: "0::/user.slice/user-1000.slice/user@1000.service/app.slice/app-alpha.scope" } });
  const b = resource({ id: "process:2", paths: ["/projects/beta"], metadata: { cgroup: "0::/user.slice/user-1000.slice/user@1000.service/app.slice/app-beta.scope" } });
  const linked = associate(linkResources([manager, a, b]), projects, config);
  assert.deepEqual(linked[0].associations, []); assert.equal(linked[1].associations.length, 1); assert.equal(linked[2].associations.length, 1);
});
test("NUL worktree and du parsing preserve whitespace, and properties preserve equals", () => {
  assert.deepEqual(parseWorktrees("worktree /work trees/a\0HEAD abc\0\0worktree /other/b\0"), ["/work trees/a", "/other/b"]);
  assert.deepEqual(parseDu("1024\t/path with\nnewline\0"), [{ path: "/path with\nnewline", bytes: 1024 }]);
  assert.equal(parseProperties("Id=a.service\nWorkingDirectory=/a=b\n\nId=b.service\n")[0].WorkingDirectory, "/a=b");
  assert.throws(() => parseDu("not a record"));
});
test("cancelled scans are partial, preserving only completed NUL records", async () => {
  const scan = await scanFolder("/folder", async () => ({ stdout: "100\t/folder/a\0" + "200\t/folder", stderr: "Permission denied", code: null, problem: "cancelled", truncated: false, duration: 1 }));
  assert.equal(scan.state, "partial"); assert.equal(scan.entries.length, 1); assert.match(scan.message, /PARTIAL/);
});
test("Btrfs subvolumes deduplicate by UUID and retain unavailable capacity", () => {
  const disks = parseDisks({ filesystems: [{ uuid: "same", source: "/dev/root[/@]", target: "/", fstype: "btrfs", size: 1000, used: 300, avail: 650, children: [{ uuid: "same", source: "/dev/root[/@home]", target: "/home", fstype: "btrfs", size: 1000 }] }, { source: "overlay", target: "/docker", fstype: "overlay", size: 1000 }, { uuid: "offline", source: "/dev/offline", target: "/offline", fstype: "ext4", size: null }] });
  assert.equal(disks.length, 2); assert.deepEqual(disks[0].mounts, ["/", "/home"]); assert.equal(disks[1].total, undefined);
});
test("Compose labels select owner and port bindings; environment is not retained", () => {
  const r = parseContainer({ id: "a".repeat(64), name: "/alpha-db", image: "postgres:17", status: "running", labels: { "com.docker.compose.project": "alpha", "com.docker.compose.service": "db", "com.docker.compose.project.working_dir": "/worktrees/alpha", "com.docker.compose.project.config_files": "/worktrees/alpha/compose.yml", secret: "sensitive" }, ports: { "5432/tcp": [{ HostIp: "127.0.0.1", HostPort: "15432" }] } });
  assert.equal(r.owner?.kind, "compose"); assert.equal(r.ports[0], "127.0.0.1:15432->5432/tcp"); assert.ok(!JSON.stringify(r).includes("sensitive"));
});
test("ss parses IPv6, multiple owners, and explicitly missing PID metadata", () => {
  const listeners = parseListeners('LISTEN 0 128 [::1]:3000 [::]:* users:(("node",pid=42,fd=1),("node",pid=43,fd=1))\nLISTEN 0 128 0.0.0.0:80 0.0.0.0:*');
  assert.deepEqual(listeners[0].related, ["process:42", "process:43"]); assert.match(listeners[1].metadata.visibility, /unavailable/);
  assert.throws(() => parseListeners("unexpected format"));
});
test("Tailscale Services and Funnel preserve route/backend/check distinctions", () => {
  const sites = tailscaleSites({ Services: { "svc:alpha": { TCP: { "443": { HTTPS: true } }, Web: { "alpha.example:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:3000" } } } }, AllowFunnel: { "alpha.example:443": true } } } }, "tailscale:host");
  assert.equal(sites[0].scope, "public"); assert.equal(sites[0].configured, true); assert.equal(sites[0].availability, "unknown"); assert.equal(sites[0].check, undefined);
  const linked = associateSites(sites, [], config); assert.match(linked[0].availability, /unknown/);
});
test("backend matching respects address and container namespace; Kamal parser strips ANSI", () => {
  const rs = [resource({ kind: "listener", ports: ["127.0.0.1:3000"] })];
  assert.equal(backendResources("http://192.168.1.20:3000", rs).length, 0);
  assert.equal(backendResources("http://127.0.0.1:3000", rs).length, 1);
  const s = tailscaleSites({ Web: { "test:80": { Handlers: { "/": { Proxy: "http://127.0.0.1:3000" } } } } }, "container")[0];
  s.namespace = "container:abc"; assert.match(associateSites([s], rs, config)[0].availability, /unknown/);
  const routes = parseKamal("\x1b[34mService\x1b[0m  Host  Path  Target  State  TLS\nalpha-web  alpha.example  /  abcdef123456:3000  running  no", "proxy");
  assert.equal(routes[0].target, "abcdef123456:3000"); assert.throws(() => parseKamal("incompatible header", "proxy"));
});
