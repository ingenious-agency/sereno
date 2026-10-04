import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestRenderer } from "@opentui/core/testing";
import { Dashboard } from "../src/ui.ts";
import { fixtureStore } from "../src/fixtures.ts";
import { Store } from "../src/store.ts";
import { installInteractions } from "../src/interactions.ts";
import type { Result } from "../src/runner.ts";

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
  const setup = await createTestRenderer({ width: 100, height: 28 });
  const ui = new Dashboard(setup.renderer, store); installInteractions(ui);
  ui.stack = [{ type: "resource", id: store.resources[0].id }]; ui.render();
  try {
    setup.mockInput.pressKey("t"); await setup.renderOnce();
    assert.match(ui.panel!.text, /All replicas/); assert.match(ui.panel!.text, /--no-deps/); assert.equal(commands.length, 0);
    setup.mockInput.pressEscape(); assert.equal(commands.length, 0);
    setup.mockInput.pressKey("t"); setup.mockInput.pressKey("y");
    await setup.waitFor(() => Boolean(ui.panel?.text.includes("Observed after refresh")));
    assert.equal(commands.filter(c => c.includes("restart")).length, 1);
    assert.match(ui.panel!.text, /Exit: 0/); assert.match(ui.panel!.text, /target no longer discovered/);
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
