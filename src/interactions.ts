import { cleanupAction, cleanupPreview, executeAction, type Action } from "./actions.ts";
import { bytes, type Scan } from "./model.ts";
import { childFolders, scanCommand, scanFolder } from "./storage.ts";
import { displayCommand, failureHint, redact, type Command, type Result } from "./runner.ts";
import { type Dashboard, type Row, type Screen } from "./ui.ts";
import type { Node, ActionPlan } from "./domain.ts";

export function installInteractions(ui: Dashboard) {
  const store = ui.store;
  const scans = new Map<string, Scan>();
  const children = new Map<string, { paths: string[]; error?: string }>();
  let job:
    { controller: AbortController; title: string; started: number; progress: number } | undefined;
  let lastOutput: { title: string; text: string } | undefined;
  let dockerStorage = "Not collected";
  const pulse = setInterval(() => {
    if (job) {
      ui.notice = `${job.title} · running ${Math.floor((Date.now() - job.started) / 1000)}s · c cancel`;
      ui.render();
    }
  }, 500);
  ui.onClose = () => {
    job?.controller.abort();
    clearInterval(pulse);
  };
  const output = (command: Command, result: Result) =>
    `${displayCommand(command)}\n\nstdout:\n${redact(result.stdout) || "(empty)"}\n\nstderr:\n${redact(result.stderr) || "(empty)"}\n\nExit: ${result.code ?? "none"} · ${result.duration}ms\n${result.problem ?? ""}${result.truncated ? " · output truncated" : ""}\n${failureHint(result)}`;
  const begin = (title: string) => {
    if (job) throw new Error(`Already running: ${job.title}. Press c to cancel.`);
    if (ui.fixture) throw new Error("Fixture mode: actions and configuration writes are disabled.");
    job = { controller: new AbortController(), title, started: Date.now(), progress: 0 };
    ui.showPanel({ title, text: "Running…", cancel: () => job?.controller.abort() });
    return job;
  };
  const finish = (title: string, text: string) => {
    lastOutput = { title, text };
    job = undefined;
    ui.notice = `${title} finished · z reopen output`;
    if (ui.panel) ui.showPanel(lastOutput);
    else ui.render();
  };
  const report = (error: unknown) => {
    job?.controller.abort();
    job = undefined;
    ui.showPanel({ title: "Action unavailable", text: redact(String(error)) });
  };
  // Storage commands retain their existing explicit preview and bounded runner.
  const execute = async (action: Action, confirmed = false) => {
    const current = begin(action.target);
    const result = await executeAction(action, confirmed, store.runner, current.controller.signal);
    await store.filesystem();
    finish(action.target, output(action.command, result));
  };
  const executeDomain = async (plan: ActionPlan) => {
    const current = begin(plan.action.label);
    const result = await store.runAction(plan, true, current.controller.signal);
    const node = store.tree.nodes[plan.nodeId];
    finish(
      plan.action.label,
      `${result.successful ? "Completed" : "Failed"}\n\n${result.text}\n\nObserved after refresh: ${node?.kind === "resource" ? node.status : node ? node.name : "target no longer discovered"}`,
    );
  };
  const previewDomain = async (nodeId: string, actionId: string) => {
    const current = begin("Refreshing action target");
    const plan = await store.previewAction(nodeId, actionId, current.controller.signal);
    if (current.controller.signal.aborted) {
      finish("Action preview", "Cancelled");
      return;
    }
    job = undefined;
    const execution = plan.action.execution;
    const command =
      execution.type === "command"
        ? displayCommand(execution.command)
        : `${execution.provider} ${execution.operation}\n${JSON.stringify(execution.target, null, 2)}`;
    ui.showPanel({
      title: "Action preview",
      text: `Target: ${store.tree.nodes[nodeId]?.name ?? nodeId}\nScope: ${plan.action.description}\n\n${command}\n\nPress y to ${plan.action.confirm ? "confirm" : "run"}; Esc cancels.`,
      confirm: () => {
        void executeDomain(plan).catch(report);
      },
    });
  };
  const editText = (title: string, initial: string, save: (value: string) => Promise<unknown>) => {
    if (ui.fixture) throw new Error("Fixture mode: configuration writes are disabled.");
    let value = initial;
    const render = () =>
      ui.showPanel({
        title,
        text: `${value}▏\n\nEnter saves · Esc cancels`,
        onKey: (key) => {
          if (key.name === "escape") {
            ui.panel = undefined;
            ui.render();
            return true;
          }
          if (key.name === "return") {
            const current = begin("Saving organization");
            void save(value.trim())
              .then(() => finish(title, "Saved"))
              .catch(report);
            return true;
          }
          if (key.name === "backspace") value = [...value].slice(0, -1).join("");
          else if (!key.ctrl && !key.meta && key.sequence && !/[\x00-\x1f\x7f]/.test(key.sequence))
            value += key.sequence;
          render();
          return true;
        },
      });
    render();
  };
  const move = (node: Node) => {
    if (ui.fixture) throw new Error("Fixture mode: configuration writes are disabled.");
    const groups = Object.values(store.tree.nodes).filter(
      (n) => n.kind === "group" && n.id !== node.id,
    );
    const choices = [
      ...(node.kind === "group" ? [{ id: null, name: "Top level" }] : []),
      ...groups,
    ];
    let index = Math.max(
      0,
      choices.findIndex((g) => g.id === node.parent),
    );
    const render = () =>
      ui.showPanel({
        title: `Move ${node.name}`,
        text:
          "↑↓ select · y save · Esc cancel\n\n" +
          choices
            .map((g, i) => `${i === index ? ">" : " "} ${g.name} · ${g.id ?? "root"}`)
            .join("\n"),
        confirm: () => {
          begin("Saving organization");
          void store
            .place(node.id, choices[index].id)
            .then(() => finish("Move", "Saved"))
            .catch(report);
        },
        onKey: (key) => {
          if (key.name === "up") {
            index = Math.max(0, index - 1);
            render();
            return true;
          }
          if (key.name === "down") {
            index = Math.min(choices.length - 1, index + 1);
            render();
            return true;
          }
          return false;
        },
      });
    render();
  };
  const inspectDocker = async (cleanup = false) => {
    const current = begin("Docker storage inventory");
    ui.panel!.text = `${displayCommand(cleanupPreview)}\n\nCollecting…`;
    ui.render();
    const result = await store.runner(cleanupPreview, current.controller.signal);
    dockerStorage = output(cleanupPreview, result);
    finish("Docker storage inventory", dockerStorage);
    if (cleanup && result.code === 0 && !result.problem && !result.truncated) {
      const action = cleanupAction();
      ui.showPanel({
        title: "Build-cache cleanup preview",
        text: `Target: ${action.target}\nScope: ${action.scope}\nCommand: ${displayCommand(action.command)}\n\nPress y to execute; Esc cancels.\n\nRead-only inventory collected ${new Date().toLocaleString()}:\n${dockerStorage}`,
        confirm: () => {
          void execute(action, true).catch(report);
        },
      });
    }
  };
  const scan = async (path: string) => {
    const current = begin(`Scan ${path}`);
    ui.panel!.text = `${displayCommand(scanCommand(path))}\n\nScanning… progress is elapsed time and output received; total work is unknown. Esc returns to navigation; c cancels.`;
    ui.render();
    const result = await scanFolder(path, store.runner, current.controller.signal, (n) => {
      current.progress = n;
    });
    scans.set(path, result);
    finish(
      `Scan ${path}`,
      `${result.state.toUpperCase()} · ${new Date(result.at).toLocaleString()}\n${result.message}\n\n${result.entries.map((e) => `${bytes(e.bytes).padStart(12)}  ${e.path}`).join("\n")}`,
    );
  };
  ui.onFolder = (path) => {
    if (!children.has(path)) {
      children.set(path, { paths: [] });
      if (!ui.fixture)
        void childFolders(path)
          .then((paths) => {
            children.set(path, { paths });
            ui.render();
          })
          .catch((e) => {
            children.set(path, { paths: [], error: String(e) });
            ui.render();
          });
    }
    const result = scans.get(path);
    const dirs = children.get(path)!;
    return {
      title: path,
      folder: path,
      rows: [
        {
          id: "scan-status",
          type: "text",
          text: result
            ? `${result.state.toUpperCase()} · ${new Date(result.at).toLocaleString()} · ${result.message}`
            : "Not scanned · s scan this folder · Enter on a child to drill down",
        },
        {
          id: "scan-total",
          type: "text",
          text: `Folder total: ${bytes(result?.entries.find((e) => e.path === path)?.bytes)}${result?.state === "partial" ? " (PARTIAL)" : ""}`,
        },
        ...(dirs.error
          ? [{ id: "scan-error", type: "text" as const, text: `unavailable: ${dirs.error}` }]
          : []),
        ...dirs.paths.map((p) => ({
          id: p,
          type: "folder" as const,
          value: p,
          text: `${bytes(result?.entries.find((e) => e.path === p)?.bytes).padStart(12)}  ${p}${result?.state === "partial" ? " [partial scan]" : ""}`,
        })),
      ],
    };
  };
  ui.onStorage = () =>
    [...scans.values()].map((s) => ({
      id: `scan:${s.path}`,
      type: "folder",
      value: s.path,
      text: `${bytes(s.entries.find((e) => e.path === s.path)?.bytes)} · ${s.state} · ${s.path} · ${new Date(s.at).toLocaleTimeString()}`,
    }));
  ui.onAction = (key: string, row: Row | undefined, screen: Screen) => {
    try {
      const node: Node | undefined =
        row?.type === "node" || row?.type === "group"
          ? row.value
          : row?.type === "action"
            ? store.tree.nodes[row.value.nodeId]
            : screen.detail && "actions" in screen.detail
              ? screen.detail
              : undefined;
      if (key === "c") {
        job?.controller.abort();
        return;
      }
      if (key === "z" && lastOutput) {
        ui.showPanel(lastOutput);
        return;
      }
      if (key === "v") {
        ui.showPanel({
          title: screen.title,
          text: node ? JSON.stringify(node, null, 2) : screen.rows.map((r) => r.text).join("\n"),
        });
        return;
      }
      if (job) throw new Error(`Already running: ${job.title}. Press c to cancel.`);
      if (key === "return" && row?.type === "action") {
        if (ui.fixture) throw new Error("Fixture mode: actions disabled.");
        void previewDomain(row.value.nodeId, row.value.actionId).catch(report);
        return;
      }
      if (key === "g" && ui.section === 1) {
        const parent =
          screen.detail && "actions" in screen.detail && screen.detail.kind === "group"
            ? screen.detail.id
            : null;
        editText("New group", "", (name) => {
          if (!name) throw new Error("Group name is required");
          return store.createGroup(name, parent);
        });
        return;
      }
      if (node) {
        if (["m", "a"].includes(key)) {
          move(node);
          return;
        }
        if (key === "n") {
          editText("Rename", node.name, (name) => {
            if (!name) throw new Error("Name is required");
            return store.place(node.id, node.parent, name);
          });
          return;
        }
        if (key === "labels") {
          editText("Labels (comma separated)", node.labels.join(", "), (value) =>
            store.place(
              node.id,
              node.parent,
              undefined,
              value
                .split(",")
                .map((s) => s.trim())
                .filter(Boolean),
            ),
          );
          return;
        }
        if (key === "actions") {
          let index = 0;
          const render = () =>
            ui.showPanel({
              title: `Actions · ${node.name}`,
              text: node.actions.length
                ? "↑↓ select · Enter previews · Esc closes\n\n" +
                  node.actions
                    .map((a, i) => `${i === index ? ">" : " "} ${a.label}: ${a.description}`)
                    .join("\n")
                : "No actions defined. Add actions in the configuration.",
              onKey: (event) => {
                if (event.name === "up") {
                  index = Math.max(0, index - 1);
                  render();
                  return true;
                }
                if (event.name === "down") {
                  index = Math.min(node.actions.length - 1, index + 1);
                  render();
                  return true;
                }
                if (event.name === "return" && node.actions[index]) {
                  if (ui.fixture) {
                    report(new Error("Fixture mode: actions disabled."));
                    return true;
                  }
                  void previewDomain(node.id, node.actions[index].id).catch(report);
                  return true;
                }
                return false;
              },
            });
          render();
          return;
        }
        const names: Record<string, string> = {
          s: "start",
          x: "stop",
          t: "restart",
          l: "logs",
          o: "open",
          h: node.actions.some((a) => a.id === "check") ? "check" : "verify",
        };
        if (names[key]) {
          if (ui.fixture) throw new Error("Fixture mode: actions disabled.");
          void previewDomain(node.id, names[key]).catch(report);
          return;
        }
      }
      if (key === "b" && ui.section === 3) {
        void inspectDocker(true).catch(report);
        return;
      }
      if (key === "return" && row?.type === "docker-storage") {
        void inspectDocker().catch(report);
        return;
      }
      if (key === "s") {
        const path = screen.folder ?? (row?.type === "folder" ? row.value : undefined);
        if (path) void scan(path).catch(report);
      }
    } catch (error) {
      report(error);
    }
  };
}
