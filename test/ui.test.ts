import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestRenderer } from "@opentui/core/testing";
import { Dashboard } from "../src/ui.ts";
import { fixtureStore } from "../src/fixtures.ts";
import { Store } from "../src/store.ts";
import { installInteractions } from "../src/interactions.ts";
import type { Result } from "../src/runner.ts";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeOrganization } from "../src/domain-schema.ts";

test("OpenTUI renders fixtures, supports navigation, filtering, details and narrow resize", async () => {
  const testUI = await createTestRenderer({ width: 100, height: 28 });
  const ui = new Dashboard(testUI.renderer, fixtureStore(), true); installInteractions(ui);
  try {
    await testUI.renderOnce(); assert.match(testUI.captureCharFrame(), /FIXTURE MODE/);
    testUI.mockInput.pressKey("2"); await testUI.renderOnce(); assert.match(testUI.captureCharFrame(), /atlas/);
    testUI.mockInput.pressKey("/"); await testUI.mockInput.typeText("beacon"); testUI.mockInput.pressEnter(); await testUI.renderOnce();
    assert.equal(ui.filter, "beacon"); assert.match(testUI.captureCharFrame(), /beacon/);
    testUI.mockInput.pressEnter(); await testUI.renderOnce(); assert.match(testUI.captureCharFrame(), /Repository\s+\/fixtures\/projects\/beacon/);
    testUI.mockInput.pressEscape(); testUI.mockInput.pressKey("3"); await testUI.renderOnce(); assert.match(testUI.captureCharFrame(), /302/);
    testUI.mockInput.pressKey("h"); await testUI.renderOnce(); assert.match(testUI.captureCharFrame(), /Fixture mode/);
    testUI.mockInput.pressEscape(); testUI.resize(48, 16); await testUI.renderOnce(); assert.match(testUI.captureCharFrame(), /FIXTURE MODE/);
  } finally { ui.close(); }
});
test("navigation stays responsive during pending discovery; unavailable tools are explicit", async () => {
  let release!: (result: Result) => void;
  const gate = new Promise<Result>(resolve => { release = resolve; });
  const store = new Store({ projectRoots: [], mappings: [], sites: [] }, () => gate);
  const testUI = await createTestRenderer({ width: 90, height: 24 });
  const ui = new Dashboard(testUI.renderer, store);
  const pending = store.refreshResources();
  try {
    testUI.mockInput.pressKey("4"); await testUI.renderOnce(); assert.equal(ui.section, 3); assert.match(testUI.captureCharFrame(), /Storage/);
    testUI.mockInput.pressKey("2"); await testUI.renderOnce(); assert.match(testUI.captureCharFrame(), /Shared infrastructure/);
    release({ stdout: "", stderr: "permission denied", code: 1, truncated: false, duration: 1 }); await pending;
    assert.ok(Object.values(store.sources).every(s => s.state === "unavailable"));
    testUI.mockInput.pressKey("1"); await testUI.renderOnce(); assert.match(testUI.captureCharFrame(), /unavailable/);
  } finally { release({ stdout: "", stderr: "", code: 1, truncated: false, duration: 0 }); ui.close(); }
});

test("UI previews exact lifecycle command, requires confirmation and shows refreshed result (mock execution)", async () => {
  const store = fixtureStore(); const commands: string[][] = [];
  store.runner = async command => {
    commands.push([command.file, ...command.args]);
    const stdout = command.file === "systemctl" ? "[]" : command.file === "tailscale" ? "{}" : "";
    return { stdout, stderr: "", code: 0, truncated: false, duration: 1 };
  };
  store.discoverHost = async () => {};
  const setup = await createTestRenderer({ width: 100, height: 28 });
  const ui = new Dashboard(setup.renderer, store); installInteractions(ui);
  ui.stack = [{ type: "resource", id: store.resources[0].id }]; ui.render();
  try {
    setup.mockInput.pressKey("t");
    for (let i = 0; i < 100 && !ui.panel?.confirm; i++) await new Promise(resolve => setTimeout(resolve, 5));
    await setup.renderOnce();
    assert.match(ui.panel!.text, /All replicas/); assert.match(ui.panel!.text, /--no-deps/); assert.equal(commands.length, 0);
    setup.mockInput.pressEscape(); assert.equal(commands.length, 0);
    setup.mockInput.pressKey("t");
    for (let i = 0; i < 100 && !ui.panel?.confirm; i++) await new Promise(resolve => setTimeout(resolve, 5));
    setup.mockInput.pressKey("y");
    await setup.waitFor(() => Boolean(ui.panel?.text.includes("Observed after refresh")));
    assert.equal(commands.filter(c => c.includes("restart")).length, 1);
    assert.match(ui.panel!.text, /Exit: 0/); assert.match(ui.panel!.text, /running/);
  } finally { ui.close(); }
});

test("command palette filters and runs contextual commands; help lists shortcuts; status is glyph plus text", async () => {
  const setup = await createTestRenderer({ width: 130, height: 32 });
  const ui = new Dashboard(setup.renderer, fixtureStore(), true); installInteractions(ui);
  try {
    await setup.renderOnce(); assert.match(setup.captureCharFrame(), /● ready/); assert.match(setup.captureCharFrame(), /Inspector/);
    setup.mockInput.pressKey("p", { ctrl: true }); await setup.renderOnce(); assert.match(setup.captureCharFrame(), /Commands/);
    await setup.mockInput.typeText("storage"); setup.mockInput.pressEnter(); await setup.renderOnce();
    assert.equal(ui.palette, undefined); assert.equal(ui.section, 3); assert.match(setup.captureCharFrame(), /Images, build cache/);
    setup.mockInput.pressKey("?"); await setup.renderOnce(); assert.match(setup.captureCharFrame(), /Keyboard shortcuts/); assert.match(ui.panel!.text, /build-cache cleanup/);
  } finally { ui.close(); }
});

test("rename and label editors accept text without triggering global shortcuts and cancel without writes", async () => {
  const setup = await createTestRenderer({ width: 110, height: 30, kittyKeyboard: true });
  const store = fixtureStore(); const before = JSON.stringify(store.config);
  const ui = new Dashboard(setup.renderer, store); installInteractions(ui);
  ui.stack = [{ type: "node", id: "compose:atlas:web" }]; ui.render();
  try {
    setup.mockInput.pressKey("n"); assert.match(ui.panel!.title, /Rename/);
    await setup.mockInput.typeText(" Quiet queues"); assert.match(ui.panel!.text, /Quiet queues/);
    assert.equal(ui.section, 0); assert.equal(ui.explanation, undefined);
    setup.mockInput.pressEscape();
    setup.mockInput.pressKey("l", { shift: true }); assert.match(ui.panel!.title, /Labels/);
    await setup.mockInput.typeText("dev, important"); assert.match(ui.panel!.text, /dev, important/);
    setup.mockInput.pressEscape(); assert.equal(JSON.stringify(store.config), before);
    setup.mockInput.pressKey("m"); assert.match(ui.panel!.title, /Move/);
    assert.match(ui.panel!.text, /Shared infrastructure/); setup.mockInput.pressEscape();
  } finally { ui.close(); }
});

test("OpenTUI creates nested groups and persists labels through the organization workflow", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sereno-ui-")), path = join(directory, "config.json");
  const setup = await createTestRenderer({ width: 110, height: 30, kittyKeyboard: true });
  const store = new Store({ projectRoots: [], mappings: [], sites: [], encargado: { enabled: false }, organization: decodeOrganization({ version: 1, groups: [{ id: "parent", name: "Parent" }], resources: [], placements: [] }) }, async c => ({ stdout: c.file === "systemctl" ? "[]" : c.file === "tailscale" ? "{}" : "", stderr: "", code: 0, duration: 1, truncated: false }), path);
  await store.refreshTree();
  const ui = new Dashboard(setup.renderer, store); installInteractions(ui);
  ui.section = 1; ui.stack = [{ type: "group", id: "parent" }]; ui.render();
  const settle = async () => { for (let i = 0; i < 100 && ui.panel?.text !== "Saved"; i++) await new Promise(resolve => setTimeout(resolve, 5)); assert.equal(ui.panel?.text, "Saved"); };
  try {
    setup.mockInput.pressKey("g"); await setup.mockInput.typeText("Child"); setup.mockInput.pressEnter(); await settle();
    const child = Object.values(store.tree.nodes).find(n => n.name === "Child")!;
    assert.equal(child.parent, "parent");
    setup.mockInput.pressEscape(); ui.stack = [{ type: "group", id: child.id }]; ui.render();
    setup.mockInput.pressKey("l", { shift: true }); await setup.mockInput.typeText("dev, quiet"); setup.mockInput.pressEnter(); await settle();
    assert.deepEqual(store.tree.nodes[child.id].labels, ["dev", "quiet"]);
    const saved = JSON.parse(await readFile(path, "utf8"));
    assert.equal(saved.organization.groups.find((g: { id: string }) => g.id === child.id).parent, "parent");
    assert.deepEqual(saved.organization.placements[0].labels, ["dev", "quiet"]);
  } finally { ui.close(); await rm(directory, { recursive: true, force: true }); }
});
