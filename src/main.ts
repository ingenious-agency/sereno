import { loadConfig } from "./config.ts";
import { Store } from "./store.ts";
import { redact } from "./runner.ts";
import { fixtureStore } from "./fixtures.ts";

try {
  if (process.argv.includes("--help")) {
    console.log(
      "Sereno — groups, resources and actions\n\nsereno [--fixtures | --snapshot | --validate-config | --organization-schema]\n\nNormal mode imports Encargado and discovers local resources. Actions are explicit and interactive.\nSERENO_CONFIG overrides ~/.config/sereno/config.json\nRequires Node >=26.4 with --experimental-ffi (the launcher supplies it).",
    );
    process.exit(0);
  }
  const fixture = process.argv.includes("--fixtures");
  if (process.argv.includes("--organization-schema")) {
    const { Schema } = await import("effect");
    const { OrganizationSchema } = await import("./domain-schema.ts");
    const document = Schema.toJsonSchemaDocument(OrganizationSchema);
    console.log(
      JSON.stringify(
        {
          $schema: "https://json-schema.org/draft/2020-12/schema",
          ...document.schema,
          $defs: document.definitions,
        },
        null,
        2,
      ),
    );
    process.exit(0);
  }
  if (process.argv.includes("--validate-config")) {
    const config = await loadConfig();
    const { buildTree, emptyOrganization } = await import("./domain.ts");
    buildTree([], config.organization ?? emptyOrganization());
    console.log("Configuration valid");
    process.exit(0);
  }
  const store = fixture ? fixtureStore() : new Store(await loadConfig());
  if (process.argv.includes("--snapshot")) {
    if (!fixture) {
      await store.refresh();
      await store.metrics();
    }
    console.log(
      redact(
        JSON.stringify(
          {
            tree: store.tree,
            overview: store.overview,
            collectors: Object.fromEntries(
              Object.entries(store.sources).map(([k, v]) => [
                k,
                { state: v.state, count: v.data.length, message: v.message },
              ]),
            ),
            disks: store.disks,
          },
          null,
          2,
        ),
      ),
    );
    store.stop();
  } else {
    if (!process.stdin.isTTY || !process.stdout.isTTY)
      throw new Error(
        "An interactive terminal is required. Use --snapshot for read-only diagnostics.",
      );
    const { startUI } = await import("./ui.ts");
    const { installInteractions } = await import("./interactions.ts");
    const { installExplain } = await import("./explain.ts");
    const ui = await startUI(store, fixture);
    installInteractions(ui);
    installExplain(ui);
    if (!fixture) store.start();
  }
} catch (e) {
  console.error(redact(`Sereno: ${e}`));
  process.exitCode = 1;
}
