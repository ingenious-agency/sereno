import { test } from "node:test";
import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import {
  explanationCommand,
  explanationSnapshot,
  explain,
  codexAnswer,
  installExplain,
} from "../src/explain.ts";
import { fixtureStore } from "../src/fixtures.ts";
import { run, type Command, type Result } from "../src/runner.ts";
import { createTestRenderer } from "@opentui/core/testing";
import { Dashboard } from "../src/ui.ts";

const ok = (stdout = "", stderr = ""): Result => ({
  stdout,
  stderr,
  code: 0,
  duration: 1,
  truncated: false,
});
const answer = (text: string) =>
  JSON.stringify({ type: "item.completed", item: { type: "agent_message", text } });

test("explanation snapshot selects the resource, redacts output, omits arbitrary metadata and is bounded", () => {
  const store = fixtureStore(),
    resource = store.resources[0];
  resource.metadata.environment = "sensitive-environment";
  const snapshot = explanationSnapshot(
    store,
    { id: resource.id, type: "resource", text: resource.name, value: resource },
    { title: "Projects", rows: [] },
    { title: "Logs", text: "password=hunter2\n" + "x".repeat(30000) },
  );
  assert.match(snapshot, /atlas-web-1/);
  assert.match(snapshot, /snapshot truncated/i);
  assert.ok(!snapshot.includes("sensitive-environment"));
  assert.ok(!snapshot.includes("hunter2"));
  assert.ok(Buffer.byteLength(snapshot) <= 24 * 1024);
});
test("Codex uses stdin, ChatGPT authentication, isolated settings and read-only sandbox; Ollama stays loopback", () => {
  const command = explanationCommand(undefined, "private snapshot", "/tmp/example");
  assert.ok(!command.args.join(" ").includes("private snapshot"));
  assert.match(command.stdin!, /private snapshot/);
  assert.ok(command.args.includes('forced_login_method="chatgpt"'));
  assert.ok(command.args.includes("--ignore-user-config"));
  assert.ok(command.args.includes("read-only"));
  assert.ok(command.args.includes("features.shell_tool=false"));
  assert.ok(command.args.includes("--ephemeral"));
  assert.equal(command.env?.OPENAI_API_KEY, undefined);
  const local = explanationCommand(
    { provider: "ollama", model: "qwen3:8b" },
    "snapshot",
    "/tmp/example",
  );
  assert.deepEqual(local.args, ["run", "qwen3:8b"]);
  assert.equal(local.env?.OLLAMA_HOST, "127.0.0.1:11434");
});
test("Codex parses only assistant output and rejects failed turns, invalid events and absent answers", () => {
  assert.equal(
    codexAnswer(
      JSON.stringify({
        type: "item.completed",
        item: { type: "command_execution", text: "do not show" },
      }) +
        "\n" +
        answer("Meaning of the resource"),
    ),
    "Meaning of the resource",
  );
  assert.throws(
    () =>
      codexAnswer(
        answer("partial") + '\n{"type":"turn.failed","error":{"message":"quota exceeded"}}',
      ),
    /quota exceeded/,
  );
  assert.throws(() => codexAnswer("not JSON"), /Unexpected/);
  assert.throws(() => codexAnswer(""), /no explanation/);
});
test("subscription execution refuses API-key login and cleans up temporary workspace after successful mock inference", async () => {
  const commands: Command[] = [];
  const value = await explain(
    undefined,
    "snapshot",
    async (c) => {
      commands.push(c);
      return c.args[0] === "login"
        ? ok("", "Logged in using ChatGPT")
        : ok(answer("An explanation"));
    },
    new AbortController().signal,
  );
  assert.equal(value, "An explanation");
  assert.equal(commands.length, 2);
  await assert.rejects(access(commands[1].cwd!));
  let calls = 0;
  await assert.rejects(
    explain(
      undefined,
      "snapshot",
      async () => {
        calls++;
        return ok("Logged in using an API key");
      },
      new AbortController().signal,
    ),
    /No API-key fallback/,
  );
  assert.equal(calls, 1);
});
test("runner passes prompts through stdin, not argument strings, and honors removed environment keys", async () => {
  const result = await run({
    file: process.execPath,
    args: [
      "-e",
      "let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>console.log(s+'|'+process.env.SERENO_TEST_EMPTY))",
    ],
    stdin: "snapshot\nwith spaces",
    env: { SERENO_TEST_EMPTY: undefined },
  });
  assert.equal(result.code, 0);
  assert.equal(result.stdout.trim(), "snapshot\nwith spaces|undefined");
});
test("Ollama checks model availability before run so missing models are not downloaded", async () => {
  const commands: Command[] = [];
  await assert.rejects(
    explain(
      { provider: "ollama", model: "missing-model" },
      "snapshot",
      async (c) => {
        commands.push(c);
        return { ...ok(), code: 1, stderr: "model not found" };
      },
      new AbortController().signal,
    ),
    /Local model unavailable/,
  );
  assert.equal(commands.length, 1);
  assert.deepEqual(commands[0].args, ["show", "missing-model"]);
});
test("e overlays confirmations without executing them, Escape restores dialog and cancels pending explanation", async () => {
  const setup = await createTestRenderer({ width: 110, height: 28 });
  const store = fixtureStore();
  let sent: Command | undefined;
  store.runner = async (command, signal) => {
    if (command.args[0] === "login") return ok("Logged in using ChatGPT");
    sent = command;
    return new Promise((resolve) => {
      signal!.addEventListener(
        "abort",
        () => resolve({ ...ok(), code: null, problem: "cancelled" }),
        { once: true },
      );
    });
  };
  const ui = new Dashboard(setup.renderer, store);
  installExplain(ui);
  let confirmed = 0;
  const original = {
    title: "Stop container?",
    text: "docker stop atlas-web-1",
    confirm: () => {
      confirmed++;
    },
  };
  ui.stack = [{ type: "resource", id: store.resources[0].id }];
  ui.showPanel(original);
  try {
    setup.mockInput.pressKey("e");
    await setup.renderOnce();
    assert.match(setup.captureCharFrame(), /Explain what/);
    setup.mockInput.pressKey("y");
    assert.equal(confirmed, 0);
    // Temporary directory creation is asynchronous; allow the actual file I/O to settle.
    for (let i = 0; i < 100 && !sent; i++) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.ok(sent);
    assert.match(sent.stdin!, /atlas-web-1/);
    setup.mockInput.pressEscape();
    await new Promise((resolve) => setTimeout(resolve, 60));
    await setup.renderOnce();
    assert.equal(ui.explanation, undefined);
    assert.equal(ui.panel, original);
    assert.equal(confirmed, 0);
    assert.match(setup.captureCharFrame(), /Stop container/);
  } finally {
    ui.close();
  }
});
test("e remains text in search and palette, and fixture explanations make no model calls", async () => {
  const setup = await createTestRenderer({ width: 90, height: 24 });
  const store = fixtureStore();
  let calls = 0;
  store.runner = async () => {
    calls++;
    throw new Error("must not execute");
  };
  const ui = new Dashboard(setup.renderer, store, true);
  installExplain(ui);
  try {
    setup.mockInput.pressKey("/");
    await setup.mockInput.typeText("e");
    assert.equal(ui.filter, "e");
    assert.equal(ui.explanation, undefined);
    setup.mockInput.pressEnter();
    setup.mockInput.pressKey("e");
    assert.match(ui.explanation!.text, /Fixture mode/);
    assert.equal(calls, 0);
    setup.mockInput.pressEscape();
    await new Promise((resolve) => setTimeout(resolve, 60));
    setup.mockInput.pressKey("p", { ctrl: true });
    await setup.mockInput.typeText("explain");
    assert.equal(ui.palette!.query, "explain");
    assert.equal(ui.explanation, undefined);
    setup.mockInput.pressEnter();
    assert.ok(ui.explanation);
    assert.equal(calls, 0);
  } finally {
    ui.close();
  }
});
