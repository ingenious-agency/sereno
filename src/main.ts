import { loadConfig } from "./config.ts";
import { Store } from "./store.ts";
import { redact } from "./runner.ts";
import { fixtureStore } from "./fixtures.ts";

try {
  if (process.argv.includes("--help")) {
    console.log("Sereno — local server dashboard\n\nsereno [--fixtures | --snapshot]\n\nNormal mode uses live read-only discovery. Actions are explicit and interactive.\nSERENO_CONFIG overrides ~/.config/sereno/config.json\nRequires Node >=26.4 with --experimental-ffi (the launcher supplies it).");
    process.exit(0);
  }
  const fixture = process.argv.includes("--fixtures");
  const store = fixture ? fixtureStore() : new Store(await loadConfig());
  if (process.argv.includes("--snapshot")) {
    if (!fixture) { await store.refresh(); await store.metrics(); }
    console.log(redact(JSON.stringify({ overview: store.overview, projects: store.projects, collectors: Object.fromEntries(Object.entries(store.sources).map(([k, v]) => [k, { state: v.state, count: v.data.length, message: v.message }])), resources: store.resources, sites: store.sites, disks: store.disks }, null, 2)));
    store.stop();
  } else {
    if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("An interactive terminal is required. Use --snapshot for read-only diagnostics.");
    const { startUI } = await import("./ui.ts");
    const { installInteractions } = await import("./interactions.ts");
    const { installExplain } = await import("./explain.ts");
    const ui = await startUI(store, fixture); installInteractions(ui); installExplain(ui);
    if (!fixture) store.start();
  }
} catch (e) { console.error(redact(`Sereno: ${e}`)); process.exitCode = 1; }
