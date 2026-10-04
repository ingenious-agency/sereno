import { EventEmitter } from "node:events";
import { associate } from "./associations.ts";
import { collectContainers, collectDisks, collectListeners, collectOverview, collectProcesses, collectServices, discoverProjects, linkResources } from "./collectors.ts";
import { discoverSites } from "./sites.ts";
import { empty, type Config, type Disk, type Overview, type Project, type Resource, type Site, type Slice } from "./model.ts";
import { redact, run, type Runner } from "./runner.ts";

export class Store extends EventEmitter {
  config: Config; runner: Runner;
  overview = empty<Overview | undefined>(undefined);
  projects = empty<Project[]>([]);
  disks = empty<Disk[]>([]);
  sites = empty<Site[]>([]);
  sources: Record<string, Slice<Resource[]>> = Object.fromEntries(["Docker", "System services", "User services", "Processes", "Listeners"].map(key => [key, empty<Resource[]>([])]));
  resources: Resource[] = [];
  private tasks = new Map<string, Promise<void>>();
  private abort = new AbortController();
  private timers: NodeJS.Timeout[] = [];
  constructor(config: Config, runner: Runner = run) { super(); this.config = config; this.runner = runner; }
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
  reassociate() { this.resources = associate(linkResources(Object.entries(this.sources).flatMap(([name, s]) => s.data.map(r => ({ ...r, related: [...r.related], ports: [...r.ports], metadata: { ...r.metadata, collector: name, collectionState: s.state, collectedAt: s.at ? new Date(s.at).toISOString() : "never" } })))), this.projects.data, this.config); }
  metrics() { return this.task("metrics", this.overview, async () => ({ data: await collectOverview() })); }
  filesystem() { return this.task("disks", this.disks, async () => ({ data: await collectDisks(this.runner, this.signal) })); }
  async discovery() {
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
  async refresh() { await Promise.all([this.metrics(), this.filesystem(), this.discovery()]); }
  start() {
    void this.refresh();
    this.timers.push(setInterval(() => void this.metrics(), 2000), setInterval(() => void this.filesystem(), 30000), setInterval(() => void this.discovery(), 30000));
  }
  stop() { this.abort.abort(); this.timers.forEach(clearInterval); }
}
