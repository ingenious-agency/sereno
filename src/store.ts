import { EventEmitter } from "node:events";
import { associate } from "./associations.ts";
import { collectContainers, collectDisks, collectListeners, collectOverview, collectProcesses, collectServices, discoverProjects, linkResources } from "./collectors.ts";
import { discoverSites } from "./sites.ts";
import { empty, type Config, type Disk, type Overview, type Project, type Resource, type Site, type Slice } from "./model.ts";
import { redact, run, type Runner } from "./runner.ts";
import { configPath } from "./config.ts";
import { loadResume, saveResume, type ResumeRecord } from "./project-start.ts";
import { projectState } from "./project-state.ts";
import { Effect, Layer, ManagedRuntime, Schedule } from "effect";
import { Application, ApplicationLive, ApplicationError, ActionExecutor, InventoryProviders, OrganizationRepository, attempt } from "./application.ts";
import { buildTree, emptyOrganization, emptyTree, type ActionPlan, type Group, type Organization, type ProviderSnapshot, type Tree } from "./domain.ts";
import { hostSnapshot } from "./providers/host.ts";
import { defaultSocket, encargadoOutput, encargadoSnapshot, executeEncargado, socketRequest } from "./providers/encargado.ts";
import { saveOrganization } from "./config.ts";
import { displayCommand, failureHint } from "./runner.ts";
import { configurationSnapshot } from "./providers/configuration.ts";

export class Store extends EventEmitter {
  config: Config; runner: Runner;
  overview = empty<Overview | undefined>(undefined);
  projects = empty<Project[]>([]);
  disks = empty<Disk[]>([]);
  sites = empty<Site[]>([]);
  sources: Record<string, Slice<Resource[]>> = Object.fromEntries(["Docker", "System services", "User services", "Processes", "Listeners"].map(key => [key, empty<Resource[]>([])]));
  resources: Resource[] = [];
  resume: ResumeRecord[] = [];
  tree: Tree = emptyTree();
  private imported: ProviderSnapshot[] = [];
  private runtime: ManagedRuntime.ManagedRuntime<Application, ApplicationError>;
  lifecyclePath = `${configPath}.lifecycle.json`;
  private resumeLoaded = false;
  async loadLifecycle() { if (!this.resumeLoaded) { this.resume = await loadResume(this.lifecyclePath); this.resumeLoaded = true; } }
  async remember(record: ResumeRecord) {
    const next = [...this.resume.filter(r => r.project !== record.project || r.key !== record.key), record];
    await saveResume(this.lifecyclePath, next); this.resume = next;
  }
  async forget(project: string, key: string) {
    const next = this.resume.filter(r => r.project !== project || r.key !== key);
    await saveResume(this.lifecyclePath, next); this.resume = next;
  }
  projectState(project: string) { return projectState(project, this.resources, associate(this.resume.filter(r => r.project === project).flatMap(r => r.resources), this.projects.data, this.config), this.sources); }
  private tasks = new Map<string, Promise<void>>();
  private abort = new AbortController();
  readonly configurationPath: string;
  constructor(config: Config, runner: Runner = run, configurationPath = configPath) {
    super(); this.config = config; this.runner = runner; this.configurationPath = configurationPath;
    const providers = [
      { id: "host", read: attempt(async () => { await this.discoverHost(); return hostSnapshot(this.projects.data, this.resources, this.sites.data); }) },
      { id: "config", read: attempt(signal => configurationSnapshot(this.config.organization ?? emptyOrganization(), this.runner, signal)) },
      ...(config.encargado?.enabled === false ? [] : [{ id: "encargado", read: attempt(async signal => encargadoSnapshot(await socketRequest(this.socket, "GET", "/v1/status", undefined, signal))) }]),
    ];
    const dependencies = Layer.mergeAll(
      Layer.succeed(InventoryProviders, { providers }),
      Layer.succeed(OrganizationRepository, { load: Effect.sync(() => this.config.organization ?? emptyOrganization()), save: organization => attempt(async () => { await saveOrganization(this.config, organization, this.configurationPath); }) }),
      Layer.succeed(ActionExecutor, { execute: execution => attempt(async signal => {
        if (execution.type === "provider") {
          if (execution.provider !== "encargado") throw new Error(`Unknown action provider: ${execution.provider}`);
          const result = await executeEncargado(this.socket, execution.operation, execution.target, signal);
          return encargadoOutput(execution.operation, result);
        }
        const result = await this.runner(execution.command, signal);
        return { text: `${displayCommand(execution.command)}\n\nstdout:\n${redact(result.stdout) || "(empty)"}\n\nstderr:\n${redact(result.stderr) || "(empty)"}\n\nExit: ${result.code ?? "none"} · ${result.duration}ms\n${result.problem ?? ""}${result.truncated ? " · output truncated" : ""}\n${failureHint(result)}`, successful: result.code === 0 && !result.problem && !result.truncated };
      }) }),
    );
    this.runtime = ManagedRuntime.make(ApplicationLive.pipe(Layer.provide(dependencies)));
    this.rebuildTree();
  }
  get socket() { return this.config.encargado?.socket ?? defaultSocket(); }
  rebuildTree() { this.tree = buildTree([hostSnapshot(this.projects.data, this.resources, this.sites.data), ...this.imported], this.config.organization ?? emptyOrganization()); }
  private publish(tree: Tree) { this.tree = tree; this.imported = tree.sources.filter(s => s.id !== "host"); this.emit("change"); return tree; }
  async refreshTree() { return this.publish(await this.runtime.runPromise(Effect.flatMap(Application, app => app.refresh), { signal: this.signal })); }
  async previewAction(nodeId: string, actionId: string, signal = this.signal) {
    try { return await this.runtime.runPromise(Effect.flatMap(Application, app => app.preview(nodeId, actionId)), { signal }); }
    finally { if (!this.signal.aborted) this.publish(await this.runtime.runPromise(Effect.flatMap(Application, app => app.snapshot))); }
  }
  async runAction(plan: ActionPlan, confirmed: boolean, signal?: AbortSignal) {
    try { return await this.runtime.runPromise(Effect.flatMap(Application, app => app.execute(plan, confirmed)), { signal }); }
    finally { if (!this.signal.aborted) this.publish(await this.runtime.runPromise(Effect.flatMap(Application, app => app.snapshot))); }
  }
  async organize(change: (organization: Organization, tree: Tree) => Organization) {
    await this.refreshTree();
    return this.publish(await this.runtime.runPromise(Effect.flatMap(Application, app => app.organize(change)), { signal: this.signal }));
  }
  async place(nodeId: string, groupId: string | null, name?: string, labels?: string[]) {
    return this.organize(organization => ({ ...organization, placements: [...organization.placements.filter(p => p.resource !== nodeId), { ...organization.placements.find(p => p.resource === nodeId), resource: nodeId, group: groupId, ...(name === undefined ? {} : { name }), ...(labels === undefined ? {} : { labels }) }] }));
  }
  async createGroup(name: string, parent: string | null) {
    const group: Group = { id: `group:${crypto.randomUUID()}`, name, parent, kind: "group", labels: [], actions: [], source: "config", details: {} };
    return this.organize(organization => ({ ...organization, groups: [...organization.groups, group] }));
  }
  get signal() { return this.abort.signal; }
  private task<T>(key: string, slice: Slice<T>, fn: () => Promise<{ data: T; issues?: string[] }>) {
    const pending = this.tasks.get(key); if (pending) return pending;
    slice.refreshing = true; this.emit("change");
    const task = (async () => {
      try { const result = await fn(); slice.data = result.data; slice.at = Date.now(); slice.state = result.issues?.length ? "partial" : Array.isArray(result.data) && !result.data.length ? "empty" : "ready"; slice.message = result.issues?.join("\n"); }
      catch (e) { slice.state = "unavailable"; slice.message = redact(String(e)); }
      finally { slice.refreshing = false; this.tasks.delete(key); this.reassociate(); this.emit("change"); }
    })();
    this.tasks.set(key, task); return task;
  }
  reassociate() { this.resources = associate(linkResources(Object.entries(this.sources).flatMap(([name, s]) => s.data.map(r => ({ ...r, related: [...r.related], ports: [...r.ports], metadata: { ...r.metadata, collector: name, collectionState: s.state, collectedAt: s.at ? new Date(s.at).toISOString() : "never" } })))), this.projects.data, this.config); this.rebuildTree(); }
  metrics() { return this.task("metrics", this.overview, async () => ({ data: await collectOverview() })); }
  filesystem() { return this.task("disks", this.disks, async () => ({ data: await collectDisks(this.runner, this.signal) })); }
  async discoverHost() {
    await Promise.all([
      this.task("projects", this.projects, async () => { const r = await discoverProjects(this.config, this.runner, this.signal); return { data: r.projects, issues: r.issues }; }),
      this.refreshResources(),
    ]);
    await this.refreshSites();
  }
  async refreshResources() {
    await Promise.all(Object.entries(this.sources).map(([key, slice]) => this.task(key, slice, async () => {
      if (key === "Docker") { const r = await collectContainers(this.runner, this.signal); return { data: r.resources, issues: r.issues }; }
      if (key === "Processes") { const r = await collectProcesses(this.runner, this.signal); return { data: r.resources, issues: r.issues }; }
      return { data: key === "Listeners" ? await collectListeners(this.runner, this.signal) : await collectServices(this.runner, key === "User services", this.signal) };
    })));
  }
  refreshSites() { return this.task("sites", this.sites, async () => {
    const result = await discoverSites(this.runner, this.resources, this.config, this.signal);
    for (const s of result.sites) s.check = this.sites.data.find(old => old.id === s.id)?.check;
    return { data: result.sites, issues: result.issues };
  }); }
  async discovery() { await this.refreshTree(); }
  async refresh() { await Promise.all([this.metrics(), this.filesystem(), this.refreshTree()]); }
  start() {
    void this.runtime.runPromise(Effect.all([
      attempt(() => this.metrics()).pipe(Effect.repeat(Schedule.spaced("2 seconds"))),
      attempt(() => this.filesystem()).pipe(Effect.repeat(Schedule.spaced("30 seconds"))),
      attempt(() => this.refreshTree()).pipe(Effect.repeat(Schedule.spaced("30 seconds"))),
    ], { concurrency: "unbounded" }), { signal: this.signal }).catch(error => { if (!this.signal.aborted) { this.tree = { ...this.tree, sources: [...this.tree.sources, { id: "application", state: "unavailable", nodes: [], message: redact(String(error)) }] }; this.emit("change"); } });
  }
  stop() { this.abort.abort(); void this.runtime.dispose(); }
}
