import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanupAction, executeAction, httpCommand, resourceAction } from "../src/actions.ts";
import { fixtureStore } from "../src/fixtures.ts";
import { clean, failureHint, redact, run, safeUrl, type Command } from "../src/runner.ts";

test("Compose action selects one existing service by labels without depending on original files", async () => {
  const r = fixtureStore().resources[0];
  const action = resourceAction(r, "restart");
  assert.equal(action.command.cwd, "/");
  assert.deepEqual(JSON.parse(action.command.stdin!), { services: { web: { image: "scratch" } } });
  assert.deepEqual(action.command.args.slice(0, 5), ["compose", "--project-name", "atlas", "--file", "-"]);
  assert.equal(action.command.env?.COMPOSE_DISABLE_ENV_FILE, "true");
  assert.deepEqual(action.command.args.slice(-4), ["restart", "--no-deps", "--", "web"]);
  assert.match(action.scope, /All replicas/);
  const executed: Command[] = [];
  const runner = async (c: Command) => { executed.push(c); return { stdout: "ok", stderr: "", code: 0, duration: 1, truncated: false }; };
  await assert.rejects(executeAction(action, false, runner), /Confirmation/); assert.equal(executed.length, 0);
  await executeAction(action, true, runner); assert.deepEqual(executed, [action.command]);
  r.owner!.files = []; r.owner!.directory = "/deleted/worktree";
  assert.deepEqual(resourceAction(r, "stop").command.args.slice(-3), ["stop", "--", "web"]);
  r.owner!.service = "--invalid"; assert.throws(() => resourceAction(r, "stop"), /labels/);
});
test("systemd actions preserve user scope and disallow privilege prompts; logs are bounded", () => {
  const r = fixtureStore().resources[0]; r.owner = { kind: "systemd", id: "web.service", user: true };
  assert.deepEqual(resourceAction(r, "stop").command.args, ["--user", "--no-ask-password", "stop", "--", "web.service"]);
  const logs = resourceAction(r, "logs"); assert.equal(logs.command.file, "journalctl"); assert.ok(logs.command.args.includes("150")); assert.equal(logs.destructive, false);
  r.owner = undefined; assert.throws(() => resourceAction(r, "stop"), /No supported/);
});
test("standalone Docker uses immutable ID; cleanup cannot select volumes or projects", async () => {
  const r = fixtureStore().resources[0]; r.owner = { kind: "docker", id: "b".repeat(64) };
  assert.deepEqual(resourceAction(r, "stop").command.args, ["stop", "b".repeat(64)]);
  const cleanup = cleanupAction(); assert.deepEqual(cleanup.command.args, ["builder", "prune", "--filter", "until=168h", "--force"]);
  let count = 0; await executeAction(cleanup, true, async () => { count++; return { stdout: "mock", stderr: "", code: 0, duration: 0, truncated: false }; }); assert.equal(count, 1);
});
test("HTTP checks are one bounded HEAD, do not follow redirects or read curl config", () => {
  const c = httpCommand(fixtureStore().sites.data[0]); assert.equal(c.args[0], "-q"); assert.ok(c.args.includes("--head")); assert.ok(!c.args.includes("--location")); assert.ok(c.args.includes("--max-time"));
  for (const url of ["file:///etc/passwd", "https://user:password@host", "https://host/?token=x"]) assert.throws(() => safeUrl(url));
});
test("runner reports unavailable, timeout, cancellation, and output limits", async () => {
  const cwd = await run({ file: process.execPath, args: [], cwd: "/no/such/sereno-worktree" });
  assert.match(cwd.problem!, /Working directory unavailable/); assert.match(failureHint(cwd), /not evidence of a permissions failure/);
  assert.match(failureHint({ ...cwd, problem: "EACCES permission denied" }), /Access denied/);
  const missing = await run({ file: "/no/such/sereno-command", args: [] }); assert.match(missing.problem!, /ENOENT/); assert.notEqual(missing.code, 0);
  const timeout = await run({ file: process.execPath, args: ["-e", "setTimeout(()=>{},10000)"], timeout: 30 }); assert.equal(timeout.problem, "timeout");
  const controller = new AbortController(); const pending = run({ file: process.execPath, args: ["-e", "setTimeout(()=>{},10000)"] }, controller.signal); controller.abort(); assert.equal((await pending).problem, "cancelled");
  const capped = await run({ file: process.execPath, args: ["-e", "process.stdout.write('x'.repeat(100000))"], limit: 100 }); assert.equal(capped.truncated, true); assert.equal(capped.stdout.length, 100);
});
test("runner uses argument arrays and redaction strips secrets and terminal escapes", async () => {
  const value = "$(touch /not-executed); spaces";
  const result = await run({ file: process.execPath, args: ["-e", "console.log(process.argv[1])", value] }); assert.equal(result.stdout.trim(), value);
  const text = redact("password=abc token:xyz https://user:pass@host/path?secret=a\x1b[31m"); assert.ok(!text.includes("abc")); assert.ok(!text.includes("xyz")); assert.ok(!text.includes("user:pass")); assert.ok(!text.includes("\x1b"));
  assert.equal(clean("a\x1b]52;c;payload\x07b"), "ab");
});
