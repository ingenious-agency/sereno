import { saveMapping } from "./config.ts";
import { cleanupAction, cleanupPreview, executeAction, httpCommand, openAction, resourceAction, type Action } from "./actions.ts";
import { bytes, type Resource, type Scan, type Site } from "./model.ts";
import { childFolders, scanCommand, scanFolder } from "./storage.ts";
import { displayCommand, failureHint, redact, type Command, type Result } from "./runner.ts";
import { type Dashboard, type Row, type Screen } from "./ui.ts";
import { executeProjectStop, formatStopPlan, planProjectStop, type StopPlan } from "./project-stop.ts";

export function installInteractions(ui: Dashboard) {
  const store = ui.store;
  const scans = new Map<string, Scan>();
  const children = new Map<string, { paths: string[]; error?: string }>();
  let job: { controller: AbortController; title: string; started: number; progress: number } | undefined;
  let lastOutput: { title: string; text: string } | undefined;
  let dockerStorage = "Not collected";
  const pulse = setInterval(() => {
    if (job) { ui.notice = `${job.title} · running ${Math.floor((Date.now() - job.started) / 1000)}s · ${bytes(job.progress)} received · c cancel`; ui.render(); }
  }, 500);
  ui.onClose = () => { job?.controller.abort(); clearInterval(pulse); };
  const output = (command: Command, result: Result) => `${displayCommand(command)}\n\nstdout:\n${redact(result.stdout) || "(empty)"}\n\nstderr:\n${redact(result.stderr) || "(empty)"}\n\nExit: ${result.code ?? "none"}${result.signal ? ` · signal ${result.signal}` : ""} · ${result.duration}ms\n${result.problem ?? ""}${result.truncated ? " · PARTIAL / output truncated" : ""}\n${failureHint(result)}`;
  const begin = (title: string) => {
    if (job) throw new Error(`Already running: ${job.title}. Press c to cancel.`);
    if (ui.fixture) throw new Error("Fixture mode: command execution, HTTP checks and configuration writes are disabled.");
    job = { controller: new AbortController(), title, started: Date.now(), progress: 0 };
    ui.showPanel({ title, text: "Running asynchronously…", cancel: () => job?.controller.abort() });
    return job;
  };
  const finish = (title: string, text: string) => {
    lastOutput = { title, text }; job = undefined; ui.notice = `${title} finished · z reopen output`;
    if (ui.panel) ui.showPanel(lastOutput); else ui.render();
  };
  const execute = async (action: Action, confirmed = false) => {
    if (action.resourceId && action.destructive) {
      const resource = store.resources.find(r => r.id === action.resourceId);
      if (!resource || resource.metadata.collectionState === "unavailable") throw new Error("Target no longer available in current discovery; refresh before acting.");
    }
    const current = begin(action.target);
    ui.panel!.text = `Target: ${action.target}\nScope: ${action.scope}\nCommand: ${displayCommand(action.command)}\n\nRunning…`; ui.render();
    const result = await executeAction(action, confirmed, store.runner, current.controller.signal);
    let observation = "";
    if (action.refresh === "resources") {
      await store.refreshResources(); await store.refreshSites();
      const r = store.resources.find(r => r.id === action.resourceId);
      const source = action.resourceId?.startsWith("container:") ? store.sources.Docker : store.sources[action.resourceId?.startsWith("systemd:user:") ? "User services" : "System services"];
      observation = `\n\nObserved after refresh: ${source?.state === "unavailable" ? "unavailable; previous data is stale" : r?.status ?? "target no longer discovered"}.\n${action.verb === "restart" ? "A running state alone cannot prove application health or successful restart." : ""}`;
    }
    if (action.refresh === "storage") {
      const inventory = await store.runner(cleanupPreview, store.signal); dockerStorage = output(cleanupPreview, inventory);
      await store.filesystem(); observation = `\n\nPost-action Docker inventory:\n${dockerStorage}`;
    }
    finish(action.target, `Scope: ${action.scope}\n${output(action.command, result)}${observation}`);
  };
  const prepare = (action: Action) => {
    if (job) throw new Error(`Already running: ${job.title}`);
    if (ui.fixture) throw new Error("Fixture mode: actions disabled.");
    const text = `Target: ${action.target}\nScope: ${action.scope}\n\n${displayCommand(action.command)}\n\n${action.destructive ? "Press y to confirm this exact command." : "Press y to run."}`;
    ui.showPanel({ title: "Command preview", text, confirm: () => { void execute(action, action.destructive).catch(report); } });
  };
  const report = (error: unknown) => { if (job) job.controller.abort(); job = undefined; ui.showPanel({ title: "Action unavailable", text: redact(String(error)) }); };
  const refreshStopSnapshot = async () => {
    await store.refreshResources(); await store.refreshSites();
    return { resources: store.resources, sites: store.sites.data };
  };
  const stopProject = async (plan: StopPlan) => {
    const current = begin(`Stop project ${plan.project}`);
    const panel = ui.panel!;
    const reports: string[] = [];
    try {
      const outcome = await executeProjectStop(plan, true, refreshStopSnapshot, store.runner, current.controller.signal, entry => {
        reports.push(`Target: ${entry.target.action.target}\n${output(entry.target.action.command, entry.result)}`);
        panel.text = `${reports.join("\n\n")}\n\nRevalidating remaining targets…`; ui.render();
      });
      await refreshStopSnapshot();
      const observed = plan.targets.map(target => target.resources.map(id => {
        const resource = store.resources.find(r => r.id === id);
        const source = id.startsWith("container:") ? store.sources.Docker : id.startsWith("process:") ? store.sources.Processes : store.sources[id.startsWith("systemd:user:") ? "User services" : "System services"];
        const replaced = id.startsWith("process:") && resource && resource.metadata.startTicks !== target.action.command.args.at(-3);
        return `${id}: ${source?.state === "unavailable" ? "unavailable / stale" : replaced ? "original process exited; PID now reused" : resource ? resource.status : "no longer discovered"}`;
      }).join("\n")).join("\n");
      finish(`Project stop: ${plan.project}`, `${outcome.stopped}\n\n${reports.join("\n\n")}\n\nObserved after refresh:\n${observed}\n\nUnmanaged watchers can respawn servers. Configured routes remain configured.\n\nExcluded from original preview:\n${plan.skipped.map(s => `${s.name}: ${s.reason}`).join("\n") || "none"}`);
    } catch (e) {
      await refreshStopSnapshot().catch(() => {});
      finish(`Project stop: ${plan.project}`, `${reports.join("\n\n")}\n\nStopped: ${redact(String(e))}. Remaining commands not executed.`);
    }
  };
  const previewProjectStop = async (project: string) => {
    if (ui.fixture) { ui.showPanel({ title: "Project stop · FIXTURE PREVIEW ONLY", text: formatStopPlan(planProjectStop(project, store.resources, store.sites.data)) }); return; }
    const current = begin("Refreshing project-stop targets");
    await refreshStopSnapshot();
    if (current.controller.signal.aborted) { finish("Project stop preview", "Cancelled"); return; }
    const plan = planProjectStop(project, store.resources, store.sites.data);
    job = undefined;
    ui.notice = "Project stop preview · nothing stopped yet";
    ui.showPanel({ title: "Stop exclusive project services", text: formatStopPlan(plan) + (plan.targets.length ? "\n\nPress y to stop exactly these targets; Esc cancels." : "\n\nNo eligible targets. Assign Suggested resources with a, or inspect the exclusion reasons."),
      ...(plan.targets.length ? { confirm: () => { void stopProject(plan).catch(report); } } : {}),
    });
  };
  const inspectDocker = async (cleanup = false) => {
    const current = begin("Docker storage inventory");
    ui.panel!.text = `${displayCommand(cleanupPreview)}\n\nCollecting…`; ui.render();
    const result = await store.runner(cleanupPreview, current.controller.signal);
    dockerStorage = output(cleanupPreview, result); finish("Docker storage inventory", dockerStorage);
    if (cleanup && result.code === 0 && !result.problem && !result.truncated) {
      const action = cleanupAction();
      ui.showPanel({ title: "Build-cache cleanup preview", text: `Target: ${action.target}\nScope: ${action.scope}\nCommand: ${displayCommand(action.command)}\n\nPress y to execute; Esc cancels.\n\nRead-only inventory collected ${new Date().toLocaleString()}:\n${dockerStorage}`, confirm: () => { void execute(action, true).catch(report); } });
    }
  };
  const scan = async (path: string) => {
    const current = begin(`Scan ${path}`);
    ui.panel!.text = `${displayCommand(scanCommand(path))}\n\nScanning… progress is elapsed time and output received; total work is unknown. Esc returns to navigation; c cancels.`; ui.render();
    const result = await scanFolder(path, store.runner, current.controller.signal, n => { current.progress = n; });
    scans.set(path, result);
    finish(`Scan ${path}`, `${result.state.toUpperCase()} · ${new Date(result.at).toLocaleString()}\n${result.message}\n\n${result.entries.map(e => `${bytes(e.bytes).padStart(12)}  ${e.path}`).join("\n")}`);
  };
  ui.onFolder = path => {
    if (!children.has(path)) {
      children.set(path, { paths: [] });
      if (!ui.fixture) void childFolders(path).then(paths => { children.set(path, { paths }); ui.render(); }).catch(e => { children.set(path, { paths: [], error: String(e) }); ui.render(); });
    }
    const result = scans.get(path); const dirs = children.get(path)!;
    return { title: path, folder: path, rows: [
      { id: "scan-status", type: "text", text: result ? `${result.state.toUpperCase()} · ${new Date(result.at).toLocaleString()} · ${result.message}` : "Not scanned · s scan this folder · Enter on a child to drill down" },
      { id: "scan-total", type: "text", text: `Folder total: ${bytes(result?.entries.find(e => e.path === path)?.bytes)}${result?.state === "partial" ? " (PARTIAL)" : ""}` },
      ...(dirs.error ? [{ id: "scan-error", type: "text" as const, text: `unavailable: ${dirs.error}` }] : []),
      ...dirs.paths.map(p => ({ id: p, type: "folder" as const, value: p, text: `${bytes(result?.entries.find(e => e.path === p)?.bytes).padStart(12)}  ${p}${result?.state === "partial" ? " [partial scan]" : ""}` })),
    ] };
  };
  ui.onStorage = () => [...scans.values()].map(s => ({ id: `scan:${s.path}`, type: "folder", value: s.path, text: `${bytes(s.entries.find(e => e.path === s.path)?.bytes)} · ${s.state} · ${s.path} · ${new Date(s.at).toLocaleTimeString()}` }));
  const assign = (target: Resource | Site) => {
    if (ui.fixture) throw new Error("Fixture mode: configuration writes disabled.");
    const projects = store.projects.data;
    const picked = new Set(target.associations.filter(a => a.state !== "Suggested").map(a => a.project));
    let index = 0;
    const previousAction = ui.onAction;
    const render = () => {
      ui.showPanel({ title: `Assign ${target.id}`, text: "Use ↑↓ and Space to toggle projects; y saves the explicit mapping.\nAn empty selection explicitly leaves this resource unassigned. Esc cancels.\n\n" + projects.map((p, i) => `${i === index ? ">" : " "} [${picked.has(p.id) ? "x" : " "}] ${p.path}`).join("\n"), confirm: () => { restore(); void saveMapping(store.config, target.id, [...picked]).then(async () => { store.reassociate(); await store.refreshSites(); ui.showPanel({ title: "Mapping saved", text: `${target.id}\n${[...picked].join("\n") || "Explicitly unassigned"}` }); }).catch(report); }, cancel: () => restore() });
    };
    const key = (k: { name: string; defaultPrevented?: boolean }) => {
      if (k.defaultPrevented) return;
      if (k.name === "up") { index = Math.max(0, index - 1); render(); }
      if (k.name === "down") { index = Math.min(projects.length - 1, index + 1); render(); }
      if (k.name === "space" && projects[index]) { const id = projects[index].id; if (picked.has(id)) picked.delete(id); else picked.add(id); render(); }
      if (["escape", "q"].includes(k.name)) restore();
    };
    const restore = () => { ui.renderer.keyInput.off("keypress", key); ui.onAction = previousAction; };
    ui.renderer.keyInput.on("keypress", key); render();
  };
  ui.onAction = (key: string, row: Row | undefined, screen: Screen) => {
    try {
      const target = row?.type === "resource" || row?.type === "site" ? row.value as Resource | Site : screen.detail && "associations" in screen.detail ? screen.detail : undefined;
      if (key === "c") { job?.controller.abort(); return; }
      if (key === "z" && lastOutput) { ui.showPanel(lastOutput); return; }
      if (key === "v") { ui.showPanel({ title: screen.title, text: target ? JSON.stringify(target, null, 2) : screen.rows.map(r => r.text).join("\n") }); return; }
      if (job) throw new Error(`Already running: ${job.title}. Press c to cancel.`);
      if (key === "stop-project" || (key === "return" && row?.type === "project-stop")) {
        const project = screen.detail && "worktrees" in screen.detail ? screen.detail : ["project", "project-stop"].includes(row?.type ?? "") ? row?.value : undefined;
        if (project) void previewProjectStop(project.id).catch(report);
        return;
      }
      if (key === "b" && ui.section === 3) { void inspectDocker(true).catch(report); return; }
      if (key === "return" && row?.type === "docker-storage") { void inspectDocker().catch(report); return; }
      if (key === "s") { const path = screen.folder ?? (row?.type === "folder" ? row.value : screen.detail && "worktrees" in screen.detail ? screen.detail.path : undefined); if (path) void scan(path).catch(report); return; }
      if (key === "a" && target) { assign(target); return; }
      if (target && "kind" in target && ["l", "x", "t"].includes(key)) {
        if (target.metadata.collectionState === "unavailable") throw new Error("Collector unavailable; this resource is stale. Refresh before acting.");
        prepare(resourceAction(target, key === "l" ? "logs" : key === "x" ? "stop" : "restart")); return;
      }
      if (target && "url" in target) {
        if (key === "o") prepare(openAction(target));
        if (key === "h") {
          const site = target; const current = begin(`HTTP ${site.url}`); const command = httpCommand(site);
          ui.panel!.text = `${displayCommand(command)}\n\nOne HEAD request; redirects are not followed. Checking…`; ui.render();
          void store.runner(command, current.controller.signal).then(result => {
            const status = Number(result.stdout.trim());
            const check = { at: Date.now(), status: result.code === 0 && status >= 100 && status <= 599 ? status : undefined, error: result.code === 0 && status >= 100 ? undefined : redact(result.problem ?? result.stderr ?? "HTTP unavailable") };
            site.check = check; const live = store.sites.data.find(s => s.id === site.id); if (live) live.check = check;
            finish(`HTTP ${site.url}`, output(command, result) + "\n\nHTTP response and backend state are independent. Redirects and authentication responses are reported without being classified as failures. HEAD 405/501 may mean this method is unsupported.");
          }).catch(report);
        }
      }
    } catch (e) { ui.showPanel({ title: "Action unavailable", text: redact(String(e)) }); }
  };
}
