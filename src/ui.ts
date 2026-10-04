import { BoxRenderable, StyledText, TextRenderable, bg, bold, createCliRenderer, fg, type CliRenderer, type KeyEvent, type TextChunk } from "@opentui/core";
import { homedir } from "node:os";
import { bytes, type Association, type Project, type Resource, type Site, type Slice } from "./model.ts";
import { redact } from "./runner.ts";
import type { Store } from "./store.ts";

type Line = TextChunk[];
export interface Row { id: string; text: string; type: "project" | "resource" | "site" | "folder" | "text" | "docker-storage" | "project-stop"; value?: any; line?: Line; heading?: boolean }
export interface Screen { title: string; status?: string; rows: Row[]; detail?: Resource | Site | Project; folder?: string }
export interface Panel { title: string; text: string; confirm?: () => void; cancel?: () => void }
interface Hint { key: string; label: string; name: string; context?: boolean }

// Palette modelled on OpenCode's default dark theme.
export const theme = {
  bg: "#0a0a0a", panel: "#141414", element: "#1e1e1e", selected: "#262626", border: "#303030",
  text: "#eeeeee", muted: "#808080", faint: "#4a4a4a",
  primary: "#fab283", secondary: "#5c9cf5", accent: "#9d7cd8",
  success: "#7fd88f", warning: "#f5a742", error: "#e06c75", info: "#56b6c2",
};
const sections = ["Overview", "Projects", "Sites", "Storage"];

const c = (color: string, text: string | number) => fg(color)(String(text));
const b = (color: string, text: string | number) => bold(fg(color)(String(text)));
const width = (line: Line) => line.reduce((n, chunk) => n + [...chunk.text].length, 0);
const plain = (line: Line) => line.map(chunk => chunk.text).join("");
/** Truncate a styled line to `cols` (with an ellipsis) and optionally pad and fill it with a background. */
function fit(line: Line, cols: number, fill?: string): Line {
  const out: Line = []; let used = 0;
  for (const chunk of line) {
    const chars = [...chunk.text];
    if (used + chars.length <= cols) { out.push(chunk); used += chars.length; continue; }
    const room = cols - used; if (room > 0) out.push({ ...chunk, text: chars.slice(0, Math.max(0, room - 1)).join("") + "…" });
    used = cols; break;
  }
  if (fill !== undefined && used < cols) out.push(c(theme.text, " ".repeat(cols - used)));
  return fill ? out.map(chunk => bg(fill)(chunk)) : out;
}
const pad = (text: string, n: number) => text.length >= n ? text.slice(0, Math.max(0, n - 1)) + (n > 0 ? " " : "") : text.padEnd(n);
const styled = (lines: Line[]) => new StyledText(lines.flatMap((line, i) => i ? [c(theme.text, "\n"), ...line] : line));

type Tone = "success" | "error" | "warning" | "muted" | "info";
export function tone(status: string): Tone {
  const s = status.toLowerCase();
  if (/fail|error|unavailable|dead|exited|unreachable|not running/.test(s)) return "error";
  if (/partial|stale|loading|restart|activating|deactivating|refreshing|unverified|paused|starting/.test(s)) return "warning";
  if (/running|active|listening|ready|healthy|^up\b|open/.test(s)) return "success";
  return "muted";
}
const glyphs: Record<Tone, string> = { success: "●", error: "✕", warning: "◐", muted: "○", info: "◆" };
const color = (t: Tone) => t === "muted" ? theme.muted : theme[t];
/** Status is always glyph + words, never colour alone. */
const badge = (status: string, cols = 0): Line => { const t = tone(status); return [c(color(t), glyphs[t] + " "), c(color(t), cols ? pad(status, cols) : status)]; };
const httpTone = (s: Site): [string, string] => {
  if (s.check?.status === undefined) return s.check?.error ? [theme.error, "HTTP error"] : [theme.muted, "not checked"];
  const n = s.check.status;
  return n < 300 ? [theme.success, `HTTP ${n}`] : n < 400 ? [theme.secondary, `HTTP ${n} redirect`] : n === 401 || n === 403 ? [theme.warning, `HTTP ${n} auth`] : [theme.error, `HTTP ${n}`];
};
const stateColor = (a: Association) => a.state === "Detected" ? theme.success : a.state === "Assigned" ? theme.secondary : theme.warning;
const assocLine = (r: Resource | Site): Line => r.associations.length
  ? r.associations.flatMap((a, i) => [...(i ? [c(theme.faint, ", ")] : []), c(stateColor(a), a.state[0]), c(theme.muted, ` ${a.project.split("/").at(-1)}`)])
  : [c(theme.faint, "unassigned")];
function gauge(used: number | undefined, total: number | undefined, cols: number): Line {
  if (used === undefined || !total) return [c(theme.faint, "·".repeat(cols)), c(theme.muted, "  unavailable")];
  const ratio = Math.max(0, Math.min(1, used / total)), filled = Math.round(ratio * cols);
  const hue = ratio > 0.9 ? theme.error : ratio > 0.75 ? theme.warning : theme.primary;
  return [c(hue, "━".repeat(filled)), c(theme.faint, "━".repeat(cols - filled)), b(theme.text, ` ${(ratio * 100).toFixed(1).padStart(5)}%`)];
}
const duration = (seconds: number) => { const d = Math.floor(seconds / 86400), h = Math.floor(seconds % 86400 / 3600), m = Math.floor(seconds % 3600 / 60); return d ? `${d}d ${h}h ${m}m` : h ? `${h}h ${m}m` : `${m}m`; };

export const sliceStatus = (s: Slice<unknown>, cadence = 60000) => `${s.state}${s.refreshing ? " / refreshing" : ""}${s.at && Date.now() - s.at > cadence ? " / STALE" : ""}${s.at ? ` · ${new Date(s.at).toLocaleTimeString()}` : ""}${s.message ? ` · ${s.message.split("\n")[0]}` : ""}`;
const text = (t: string, line?: Line): Row => ({ id: `text:${t}:${Math.random()}`, type: "text", text: t, line });
const head = (t: string, extra = ""): Row => ({ id: `head:${t}`, type: "text", text: t, heading: true, line: [b(theme.accent, t.toUpperCase()), c(theme.muted, extra ? `  ${extra}` : "")] });
const blank = (): Row => ({ id: `blank:${Math.random()}`, type: "text", text: "", heading: true, line: [] });
const kv = (label: string, value: string | Line, valueColor = theme.text): Row => {
  const v = typeof value === "string" ? [c(valueColor, value)] : value;
  return text(`${label}: ${plain(v)}`, [c(theme.muted, pad(label, 14)), ...v]);
};
const lines = (t: string): Row[] => t.split("\n").map(line => text(line, [c(theme.muted, line)]));
const resourceRow = (r: Resource): Row => ({ id: r.id, type: "resource", value: r, text: `${r.kind} ${r.name} [${r.status}] ${r.associations.map(a => `${a.state}: ${a.project.split("/").at(-1)}`).join(", ") || "Unassigned"}`,
  line: [...badge(r.status, 13), c(theme.muted, pad(r.kind, 10)), c(theme.text, pad(r.name, 30)), ...assocLine(r)] });
const siteRow = (s: Site): Row => { const [hc, ht] = httpTone(s); return { id: s.id, type: "site", value: s, text: `${s.url} [${s.scope}] ${s.availability} ${ht}`,
  line: [...badge(s.availability.split(";")[0], 19), c(theme.secondary, pad(s.url.replace(/^https?:\/\//, ""), 34)), c(theme.accent, pad(s.scope, 9)), c(hc, ht)] }; };
const folderRow = (path: string, label?: Line): Row => ({ id: path, type: "folder", value: path, text: path, line: [c(theme.primary, "▸ "), ...(label ?? [c(theme.text, path.replace(homedir(), "~"))])] });

export class Dashboard {
  store: Store; renderer: CliRenderer; fixture: boolean;
  section = 0; selected = 0; filter = ""; searching = false;
  stack: { type: "project" | "resource" | "site" | "folder"; id: string }[] = [];
  panel?: Panel; panelScroll = 0;
  explanation?: Panel; explanationScroll = 0;
  palette?: { query: string; index: number };
  notice = "Read-only discovery runs in the background. Missing access is shown explicitly.";
  onAction?: (key: string, row: Row | undefined, screen: Screen) => void;
  onExplain?: (row: Row | undefined, screen: Screen, panel?: Panel) => void;
  onFolder?: (path: string) => Screen;
  onStorage?: () => Row[];
  onClose?: () => void;
  private header: TextRenderable; private list: BoxRenderable; private listHead: TextRenderable; private body: TextRenderable;
  private side: BoxRenderable; private sideText: TextRenderable; private footer: TextRenderable;
  private modal: BoxRenderable; private modalText: TextRenderable; private modalFooter: TextRenderable;
  private currentRows: Row[] = [];
  private change: () => void;
  private closed = false;
  constructor(renderer: CliRenderer, store: Store, fixture = false) {
    this.renderer = renderer; this.store = store; this.fixture = fixture;
    const root = new BoxRenderable(renderer, { width: "100%", height: "100%", flexDirection: "column", backgroundColor: theme.bg });
    this.header = new TextRenderable(renderer, { height: 1, marginX: 1, wrapMode: "none" });
    const main = new BoxRenderable(renderer, { flexGrow: 1, flexDirection: "row", gap: 1, marginX: 1 });
    this.list = new BoxRenderable(renderer, { flexGrow: 1, flexDirection: "column", border: true, borderStyle: "rounded", borderColor: theme.border, titleColor: theme.text, paddingX: 1, backgroundColor: theme.bg });
    this.listHead = new TextRenderable(renderer, { height: 1, wrapMode: "none" });
    this.body = new TextRenderable(renderer, { flexGrow: 1, wrapMode: "none", overflow: "hidden" });
    this.side = new BoxRenderable(renderer, { width: 40, flexDirection: "column", border: true, borderStyle: "rounded", borderColor: theme.border, title: " Inspector ", titleColor: theme.muted, paddingX: 1, backgroundColor: theme.panel });
    this.sideText = new TextRenderable(renderer, { flexGrow: 1, wrapMode: "word", overflow: "hidden" });
    this.footer = new TextRenderable(renderer, { height: 2, marginX: 1, wrapMode: "none" });
    this.modal = new BoxRenderable(renderer, { position: "absolute", zIndex: 10, flexDirection: "column", border: true, borderStyle: "rounded", borderColor: theme.primary, titleColor: theme.primary, paddingX: 1, backgroundColor: theme.panel, visible: false });
    this.modalText = new TextRenderable(renderer, { flexGrow: 1, wrapMode: "none", overflow: "hidden" });
    this.modalFooter = new TextRenderable(renderer, { height: 1, wrapMode: "none" });
    this.list.add(this.listHead); this.list.add(this.body); this.side.add(this.sideText);
    main.add(this.list); main.add(this.side);
    this.modal.add(this.modalText); this.modal.add(this.modalFooter);
    root.add(this.header); root.add(main); root.add(this.footer); root.add(this.modal); renderer.root.add(root);
    this.change = () => this.render(); store.on("change", this.change);
    renderer.keyInput.on("keypress", key => this.key(key)); renderer.on("resize", this.change);
    this.render();
  }
  close() { if (this.closed) return; this.closed = true; this.store.off("change", this.change); this.store.stop(); this.onClose?.(); this.renderer.destroy(); }
  showPanel(panel: Panel) { this.panel = panel; this.panelScroll = 0; this.render(); }

  screen(): Screen {
    const { store } = this; const top = this.stack.at(-1);
    if (top?.type === "folder") return this.onFolder?.(top.id) ?? { title: top.id, folder: top.id, rows: lines("Folder scan not yet collected") };
    if (top?.type === "resource") {
      const r = store.resources.find(r => r.id === top.id);
      if (!r) return { title: "Resource disappeared", rows: lines("Refresh discovery to see current resources.") };
      const related = store.resources.filter(x => r.related.includes(x.id));
      return { title: r.name, status: r.metadata.collectionState, detail: r, rows: [
        head("Resource"), kv("ID", r.id, theme.muted), kv("Type", r.kind), kv("State", badge(r.status)),
        kv("Owner", r.owner ? `${r.owner.kind}${r.owner.user ? " (user)" : ""} · ${r.owner.service ?? r.owner.id}` : "No supported lifecycle owner", r.owner ? theme.text : theme.muted),
        kv("CPU", r.cpu ?? "unavailable", r.cpu ? theme.text : theme.muted), kv("Memory", r.memory ?? "unavailable", r.memory ? theme.text : theme.muted),
        kv("Ports", r.ports.join(", ") || "none observed", r.ports.length ? theme.info : theme.muted),
        blank(), head("Paths"), ...(r.paths.length ? r.paths.map(p => text(p, [c(theme.text, p)])) : lines("unavailable")),
        blank(), head("Associations"), ...(r.associations.length ? r.associations.flatMap(a => [text(`${a.state} ${a.project}`, [b(stateColor(a), pad(a.state, 10)), c(theme.text, a.project)]), text(a.reason, [c(theme.muted, `          ${a.reason}`)])]) : lines("Unassigned · press a to assign")),
        blank(), head("Metadata"), ...Object.entries(r.metadata).map(([k, v]) => kv(k, v, theme.muted)),
        ...(related.length ? [blank(), head("Related resources"), ...related.map(resourceRow)] : []),
      ] };
    }
    if (top?.type === "site") {
      const s = store.sites.data.find(s => s.id === top.id);
      if (!s) return { title: "Site disappeared", rows: lines("No longer in discovered configuration.") };
      const [hc, ht] = httpTone(s);
      return { title: s.url, detail: s, rows: [
        head("Route"), kv("URL", s.url, theme.secondary), kv("Scope", s.scope, theme.accent), kv("Source", s.source),
        kv("Configured", s.configured ? "yes (observed configuration)" : "unverified (manual entry)", s.configured ? theme.success : theme.warning),
        blank(), head("Proxy chain"), text(s.chain.join(" → "), s.chain.flatMap((hop, i) => [...(i ? [c(theme.faint, "  →  ")] : []), c(theme.text, hop)])),
        blank(), head("Backend"), kv("Address", s.backend ?? "none / unknown", s.backend ? theme.text : theme.muted), kv("Availability", badge(s.availability)),
        blank(), head("HTTP check", "independent from route and backend"), kv("Response", ht, hc), kv("Last check", s.check ? new Date(s.check.at).toLocaleString() : "never", theme.muted),
        ...(s.check?.error ? [kv("Error", s.check.error, theme.error)] : []),
        blank(), head("Associations"), ...(s.associations.length ? s.associations.map(a => text(`${a.state} ${a.project}: ${a.reason}`, [b(stateColor(a), pad(a.state, 10)), c(theme.text, a.project.split("/").at(-1)!), c(theme.muted, `  ${a.reason}`)])) : lines("Unassigned · press a to assign")),
        blank(), head("Linked resources"), ...store.resources.filter(r => s.resourceIds.includes(r.id)).map(resourceRow),
      ] };
    }
    if (top?.type === "project") {
      const project = store.projects.data.find(p => p.id === top.id);
      const shared = top.id === "shared";
      const resources = store.resources.filter(r => shared ? r.associations.filter(a => a.state !== "Suggested").length !== 1 : r.associations.some(a => a.project === top.id));
      const sites = store.sites.data.filter(s => s.associations.some(a => a.project === top.id));
      const scan = project && this.onStorage?.().find(row => row.value === project.path);
      return { title: shared ? "Shared infrastructure / Unassigned" : project?.name ?? top.id, detail: project, rows: project ? [
        head("Repository"), kv("Repository", project.path), kv("Git", project.git),
        kv("Folder size", scan ? scan.text : "not scanned · s to scan on demand", scan ? theme.text : theme.muted),
        { id: `stop:${project.id}`, type: "project-stop", value: project, text: "Stop exclusive project services · X / Enter previews exact targets", line: [c(theme.warning, "■ "), c(theme.text, "Stop exclusive project services"), c(theme.muted, "  X / ⏎ preview")] },
        blank(), head("Worktrees", String(project.worktrees.length)), ...(project.worktrees.length ? project.worktrees.map(w => text(w, [c(theme.faint, "⎇ "), c(theme.text, w.replace(homedir(), "~"))])) : lines("none / unavailable")),
        blank(), head("Storage"), folderRow(project.path, [c(theme.text, "Folder usage"), c(theme.muted, "  ⏎ drill down")]),
        blank(), head("Sites", String(sites.length)), ...(sites.length ? sites.map(siteRow) : lines("No associated sites")),
        blank(), head("Resources", `${resources.length} unique · suggestions included · shared resources are not summed`), ...(resources.length ? resources.map(resourceRow) : lines("No associated resources")),
      ] : [
        ...lines("Resources with no confirmed project or with multiple confirmed projects. Suggestions are not assignments."), blank(),
        head("Resources", String(resources.length)), ...resources.map(resourceRow),
      ] };
    }
    const w = this.contentWidth(), barW = Math.max(10, Math.min(36, w - 52));
    if (this.section === 0) {
      const o = store.overview.data, m = o?.memory;
      const running = store.resources.filter(r => r.kind === "container" && r.status === "running");
      const failed = store.resources.filter(r => r.kind === "service" && r.status.startsWith("failed"));
      return { title: "Overview", status: sliceStatus(store.overview, 6000), rows: [
        head("System"), ...(o ? [
          kv("Host", [b(theme.text, o.hostname), c(theme.muted, `  ${o.os} · kernel ${o.kernel}`)]), kv("Uptime", duration(o.uptime)),
          kv("CPU", o.cpu), kv("Topology", `${o.cores ?? "unavailable"} cores · ${o.threads} threads`),
          blank(), head("Processor"),
          kv("Utilization", o.utilization === undefined ? [c(theme.muted, "unavailable (sampling…)")] : [...gauge(o.utilization, 100, barW), c(theme.muted, "  current")]),
          kv("Load average", [...o.load.flatMap((n, i) => [b(theme.text, n.toFixed(2)), c(theme.muted, ["  1m   ", "  5m   ", "  15m"][i])]), c(theme.faint, "  (run-queue, not %)")]),
          blank(), head("Memory"),
          kv("RAM", m ? [...gauge(m.used, m.total, barW), c(theme.muted, `  ${bytes(m.used)} / ${bytes(m.total)} · ${bytes(m.available)} available`)] : [c(theme.muted, "unavailable")]),
          kv("Swap", m ? [...gauge(m.swapUsed, m.swapTotal || undefined, barW), c(theme.muted, `  ${bytes(m.swapUsed)} / ${bytes(m.swapTotal)}`)] : [c(theme.muted, "unavailable")]),
          kv("Temperatures", o.temperatures.join(" · ") || "unavailable", o.temperatures.length ? theme.text : theme.muted),
        ] : lines("Loading host metrics…")),
        blank(), head("Filesystems", sliceStatus(store.disks)),
        ...store.disks.data.map(d => kv(d.source.split("/").at(-1)!, [...gauge(d.used, d.total, barW), c(theme.muted, `  ${bytes(d.used)} / ${bytes(d.total)} · ${bytes(d.available)} free · ${d.type}`)])),
        blank(), head("Running containers", String(running.length)), ...(running.length ? running.map(resourceRow) : lines("None running or Docker unavailable")),
        blank(), head("Failed services", String(failed.length)), ...(failed.length ? failed.map(resourceRow) : [text("none", [c(theme.success, "✓ "), c(theme.muted, "no failed units observed")])]),
        blank(), head("Collectors"), ...Object.entries(store.sources).map(([name, s]) => text(`${name}: ${sliceStatus(s)}`, [...badge(s.state + (s.refreshing ? " ↻" : ""), 14), c(theme.text, pad(name, 18)), c(theme.muted, `${s.data.length} items${s.at ? ` · ${new Date(s.at).toLocaleTimeString()}` : ""}${s.message ? ` · ${s.message.split("\n")[0]}` : ""}`)])),
      ] };
    }
    if (this.section === 1) return { title: "Projects", status: sliceStatus(store.projects), rows: [
      ...store.projects.data.map(p => {
        const confirmed = store.resources.filter(r => r.associations.some(a => a.project === p.id && a.state !== "Suggested")).length;
        const suggested = store.resources.filter(r => r.associations.some(a => a.project === p.id && a.state === "Suggested")).length;
        return { id: p.id, type: "project" as const, value: p, text: `${p.name} ${p.path} · ${p.worktrees.length} worktrees · ${confirmed} confirmed resources`,
          line: [c(theme.primary, "◆ "), b(theme.text, pad(p.name, 22)), c(theme.muted, pad(p.path.replace(homedir(), "~"), 34)), c(theme.info, `⎇ ${p.worktrees.length}`), c(theme.muted, "  "), c(theme.success, `● ${confirmed}`), c(theme.muted, " confirmed"), ...(suggested ? [c(theme.warning, `  ◐ ${suggested}`), c(theme.muted, " suggested")] : [])] };
      }),
      blank(),
      { id: "shared", type: "project", text: "Shared infrastructure / Unassigned", line: [c(theme.muted, "◇ "), c(theme.text, "Shared infrastructure / Unassigned")] },
    ] };
    if (this.section === 2) return { title: "Sites", status: sliceStatus(store.sites), rows: store.sites.data.length ? store.sites.data.map(siteRow) : lines("No sites discovered. Add manual sites in the config file.") };
    const folders = [...store.projects.data.map(p => p.path), `${homedir()}/.cache`, `${homedir()}/.npm`, `${homedir()}/.bun/install/cache`, `${homedir()}/.local/share/mise`, "/var/cache/pacman/pkg"];
    const scans = this.onStorage?.() ?? [];
    return { title: "Storage", status: sliceStatus(store.disks), rows: [
      head("Filesystems", "deduplicated by UUID · Btrfs chunks are not capacity"),
      ...store.disks.data.flatMap(d => [
        kv(d.source.split("/").at(-1)!, [...gauge(d.used, d.total, barW), c(theme.muted, `  ${bytes(d.used)} / ${bytes(d.total)} · ${bytes(d.available)} free · ${d.type}`)]),
        text(d.mounts.join(", "), [c(theme.faint, " ".repeat(14) + d.mounts.join("  "))]),
      ]),
      blank(), head("Folders", "scanned on demand · ⏎ drill down · s scan"), ...folders.map(path => folderRow(path)),
      blank(), head("Docker"), { id: "docker-storage", type: "docker-storage", text: "Docker images / build cache / volumes · Enter to inspect on demand", line: [c(theme.info, "◆ "), c(theme.text, "Images, build cache & volumes"), c(theme.muted, "  ⏎ inspect · b cleanup preview")] },
      ...(scans.length ? [blank(), head("Recent scans"), ...scans.map(row => ({ ...row, line: [...badge(row.text.split(" · ")[1] ?? "", 12), c(theme.text, row.text)] }))] : []),
      blank(), ...lines("du totals can overlap; compression, reflinks, snapshots and permissions affect results.\nDocker sizes/reclaimable bytes are estimates, not guaranteed physical savings."),
    ] };
  }

  private contentWidth() { const w = this.renderer.width; return Math.max(10, w - 6 - (this.showSide() ? 41 : 0)); }
  private showSide() { return this.renderer.width >= 120 && this.renderer.height >= 16; }
  private skip = (row?: Row) => Boolean(row?.heading);
  private move(delta: number) {
    const rows = this.currentRows; if (!rows.length) return;
    let next = Math.max(0, Math.min(rows.length - 1, this.selected + delta));
    const step = delta < 0 ? -1 : 1;
    while (this.skip(rows[next]) && next + step >= 0 && next + step < rows.length) next += step;
    if (this.skip(rows[next])) { next = this.selected; }
    this.selected = next;
  }
  /** Hints for the current target. Shared by the status bar, the help screen and the command palette. */
  hints(): Hint[] {
    const screen = this.screen(), row = this.currentRows[this.selected];
    const target = row?.value ?? screen.detail;
    const h = (key: string, label: string, name = key): Hint => ({ key, label, name, context: true });
    const context: Hint[] = [];
    if (row && ["project", "resource", "site", "folder"].includes(row.type)) context.push(h("⏎", "open", "return"));
    if (row?.type === "docker-storage") context.push(h("⏎", "inspect docker", "return"));
    if (row?.type === "project-stop") context.push(h("⏎", "preview stop", "return"));
    if ((screen.detail && "worktrees" in screen.detail) || (row?.type === "project" && row.value)) context.push(h("X", "stop project", "stop-project"));
    if (target && typeof target === "object" && "url" in target) context.push(h("o", "open in browser"), h("h", "HTTP check"), h("a", "assign"));
    else if (target && typeof target === "object" && "kind" in target) context.push(h("l", "logs"), h("x", "stop"), h("t", "restart"), h("a", "assign"));
    if (this.section === 3 || screen.folder || row?.type === "folder" || (target && typeof target === "object" && "worktrees" in target)) context.push(h("s", "scan"), h("c", "cancel scan"));
    if (this.section === 3 && !this.stack.length) context.push(h("b", "build-cache cleanup"));
    context.unshift(h("e", "explain"));
    context.push(h("v", "raw details"), h("z", "last output"));
    return [...context,
      { key: "/", label: "search", name: "/" }, { key: "r", label: "refresh", name: "r" }, { key: "esc", label: "back", name: "escape" },
      { key: "tab", label: "section", name: "tab" }, { key: "ctrl+p", label: "commands", name: "palette" }, { key: "?", label: "help", name: "help" }, { key: "q", label: "quit", name: "q" }];
  }
  private paletteItems() {
    const items = [
      ...this.hints().filter(h => !["palette", "escape", "/"].includes(h.name)).map(h => ({ ...h, label: h.label[0].toUpperCase() + h.label.slice(1) })),
      ...sections.map((s, i) => ({ key: String(i + 1), label: `Go to ${s}`, name: String(i + 1), context: false })),
      { key: "/", label: "Search / filter", name: "/", context: false },
    ];
    const q = this.palette?.query.toLowerCase() ?? "";
    return items.filter(i => !q || i.label.toLowerCase().includes(q));
  }
  private help() {
    const hints = this.hints();
    return { title: "Keyboard shortcuts", text: [
      "Navigation", "  ↑↓ / j k     move           PgUp PgDn   page", "  ⏎ enter      open detail    esc         back / clear filter", "  tab ← →      switch section 1–4         jump to section", "",
      "General", "  /            search          r          refresh discovery", "  ctrl+p       command palette ?          this help", "  q / ctrl+c   quit", "",
      "Here", ...hints.filter(h => h.context).map(h => `  ${h.key.padEnd(13)}${h.label}`), "",
      "Lifecycle actions always preview the exact command and ask for confirmation.", "Sereno never escalates privileges.",
    ].join("\n") };
  }
  private dispatch(name: string) {
    if (name === "help") { this.showPanel(this.help()); return; }
    if (name === "palette") { this.palette = { query: "", index: 0 }; this.render(); return; }
    this.key({ name, sequence: name.length === 1 ? name : "", ctrl: false, meta: false, shift: false } as KeyEvent);
  }

  key(key: KeyEvent) {
    if (this.closed) return;
    if (key.ctrl && key.name === "c") { this.close(); return; }
    if (this.palette) {
      const items = this.paletteItems();
      if (key.name === "escape") this.palette = undefined;
      else if (key.name === "up") this.palette.index = Math.max(0, this.palette.index - 1);
      else if (key.name === "down") this.palette.index = Math.min(items.length - 1, this.palette.index + 1);
      else if (key.name === "return") { const item = items[this.palette.index]; this.palette = undefined; if (item) { this.dispatch(item.name); return; } }
      else if (key.name === "backspace") { this.palette.query = this.palette.query.slice(0, -1); this.palette.index = 0; }
      else if (!key.ctrl && !key.meta && key.sequence && !/[\x00-\x1f\x7f]/.test(key.sequence)) { this.palette.query += key.sequence; this.palette.index = 0; }
      this.render(); return;
    }
    if (!this.searching && key.name === "q") { this.close(); return; }
    if (this.explanation) {
      key.preventDefault?.();
      if (key.name === "escape") { this.explanation.cancel?.(); this.explanation = undefined; }
      else if (key.name === "c") this.explanation.cancel?.();
      else if (["down", "j", "pagedown"].includes(key.name)) this.explanationScroll += key.name === "pagedown" ? 10 : 1;
      else if (["up", "k", "pageup"].includes(key.name)) this.explanationScroll = Math.max(0, this.explanationScroll - (key.name === "pageup" ? 10 : 1));
      this.render(); return;
    }
    if (!this.searching && !key.ctrl && !key.meta && key.name === "e") {
      key.preventDefault?.();
      this.onExplain?.(this.currentRows[this.selected], this.screen(), this.panel);
      return;
    }
    if (this.panel) {
      if (key.name === "escape") { if (this.panel.confirm) this.panel.cancel?.(); this.panel = undefined; }
      else if (key.name === "y" && this.panel.confirm) { const confirm = this.panel.confirm; this.panel.confirm = undefined; confirm(); }
      else if (key.name === "c") this.panel.cancel?.();
      else if (["down", "j", "pagedown"].includes(key.name)) this.panelScroll += key.name === "pagedown" ? 10 : 1;
      else if (["up", "k", "pageup"].includes(key.name)) this.panelScroll = Math.max(0, this.panelScroll - (key.name === "pageup" ? 10 : 1));
      this.render(); return;
    }
    if (this.searching) {
      if (key.name === "escape") { this.searching = false; this.filter = ""; }
      else if (key.name === "return") this.searching = false;
      else if (key.name === "backspace") this.filter = this.filter.slice(0, -1);
      else if (!key.ctrl && !key.meta && key.sequence && !/[\x00-\x1f\x7f]/.test(key.sequence)) this.filter += key.sequence;
      this.selected = 0; this.render(); return;
    }
    if (key.ctrl && key.name === "p") { this.dispatch("palette"); return; }
    if (key.sequence === "?" || key.name === "?") { this.dispatch("help"); return; }
    if (key.name === "escape") { if (this.filter) this.filter = ""; else this.stack.pop(); this.selected = 0; }
    else if (key.name === "/") { this.searching = true; this.filter = ""; }
    else if (["1", "2", "3", "4", "tab", "left", "right"].includes(key.name)) {
      this.section = /^\d$/.test(key.name) ? Number(key.name) - 1 : (this.section + (key.name === "left" || key.shift ? 3 : 1)) % 4;
      this.stack = []; this.selected = 0; this.filter = "";
    }
    else if (["up", "k", "pageup"].includes(key.name)) this.move(key.name === "pageup" ? -10 : -1);
    else if (["down", "j", "pagedown"].includes(key.name)) this.move(key.name === "pagedown" ? 10 : 1);
    else if (key.name === "home") { this.selected = 0; this.move(0); }
    else if (key.name === "end") { this.selected = this.currentRows.length - 1; this.move(0); }
    else if (key.name === "r") { if (!this.fixture) void this.store.refresh(); }
    else if (key.name === "X" || (key.name === "x" && key.shift)) this.onAction?.("stop-project", this.currentRows[this.selected], this.screen());
    else if (key.name === "return") {
      const row = this.currentRows[this.selected];
      if (row && ["project", "resource", "site", "folder"].includes(row.type)) { this.stack.push({ type: row.type as "project", id: row.type === "folder" ? row.value : row.id }); this.selected = 0; this.filter = ""; }
      else this.onAction?.(key.name, row, this.screen());
    } else this.onAction?.(key.name, this.currentRows[this.selected], this.screen());
    this.render();
  }

  render() {
    if (this.closed) return;
    const W = this.renderer.width, H = this.renderer.height;
    const screen = this.screen();
    const previous = this.currentRows[this.selected]?.id;
    this.currentRows = screen.rows.filter(row => !this.filter || (!row.heading && row.text.toLowerCase().includes(this.filter.toLowerCase())));
    // Preserve exact resource selection when a collector changes ordering.
    if (previous && this.currentRows.some(row => row.id === previous) && this.currentRows[this.selected]?.id !== previous) this.selected = this.currentRows.findIndex(row => row.id === previous);
    this.selected = Math.max(0, Math.min(this.selected, this.currentRows.length - 1));
    if (this.skip(this.currentRows[this.selected])) this.move(1);
    this.renderHeader(W);
    this.renderList(screen);
    this.renderSide(screen);
    this.renderFooter(W);
    this.renderModal(W, H);
  }
  private renderHeader(W: number) {
    const refreshing = [this.store.overview, this.store.projects, this.store.sites, this.store.disks, ...Object.values(this.store.sources)].some(s => s.refreshing);
    const logo: Line = [b(theme.primary, "◆ sereno"), c(theme.muted, this.store.overview.data ? ` ${this.store.overview.data.hostname}` : "")];
    const right: Line = [
      ...(refreshing ? [c(theme.warning, "↻ syncing  ")] : []),
      ...(this.fixture ? [bold(bg(theme.warning)(fg(theme.bg)(" FIXTURE MODE ")))] : [c(theme.success, "● live")]),
    ];
    const tabs = (compact: boolean): Line => sections.flatMap((s, i) => {
      const active = i === this.section;
      const label = compact && !active ? ` ${i + 1} ` : ` ${i + 1} ${s} `;
      return [active ? bold(bg(theme.primary)(fg(theme.bg)(label))) : c(theme.muted, label), c(theme.muted, " ")];
    });
    // Degrade in order: compact tabs, then drop the logo. The mode badge is never dropped.
    const cols = W - 2, fits = (l: Line, m: Line) => width(l) + width(m) + width(right) + 3 <= cols;
    let middle = tabs(false), left = logo;
    if (!fits(left, middle)) middle = tabs(true);
    if (!fits(left, middle)) left = [];
    const lead = left.length ? [...left, c(theme.text, "   ")] : [];
    const used = width(lead) + width(middle);
    this.header.content = styled([[...fit([...lead, ...middle], Math.max(0, cols - width(right) - 1)), c(theme.text, " ".repeat(Math.max(1, cols - Math.min(used, cols - width(right) - 1) - width(right)))), ...right]]);
  }
  private renderList(screen: Screen) {
    const cols = this.contentWidth(), rows = Math.max(1, this.renderer.height - 6);
    const crumbs = [sections[this.section], ...this.stack.map((s, i) => i === this.stack.length - 1 ? screen.title : s.type === "folder" ? s.id.split("/").at(-1) : this.store.projects.data.find(p => p.id === s.id)?.name ?? s.id.split(":").at(-1)!.slice(0, 16))];
    this.list.title = ` ${crumbs.join(" › ")} `;
    this.list.borderColor = this.panel || this.explanation || this.palette ? theme.border : theme.faint;
    const position = this.currentRows.length ? `${this.selected + 1}/${this.currentRows.length}` : "0";
    const status: Line = this.searching || this.filter
      ? [c(theme.primary, "/ "), c(theme.text, this.filter), ...(this.searching ? [c(theme.primary, "▏")] : [c(theme.muted, "  esc clears")])]
      : screen.status ? badge(screen.status) : [c(theme.muted, `${this.stack.length ? "esc back" : "⏎ open"}`)];
    const statusFit = fit(status, Math.max(1, cols - position.length - 2));
    this.listHead.content = styled([[...statusFit, c(theme.text, " ".repeat(Math.max(1, cols - width(statusFit) - position.length))), c(theme.muted, position)]]);
    if (!this.currentRows.length) { this.body.content = styled([[], [c(theme.muted, this.filter ? `  No rows match “${this.filter}”.` : "  (empty) Nothing discovered here yet.")]]); return; }
    const start = Math.max(0, Math.min(this.selected - Math.floor(rows / 2), this.currentRows.length - rows));
    this.body.content = styled(this.currentRows.slice(start, start + rows).map((row, i) => {
      const active = start + i === this.selected;
      const content = row.line ?? [c(theme.text, row.text)];
      const redacted = content.map(chunk => ({ ...chunk, text: redact(chunk.text) }));
      return active ? [c(theme.primary, "▌"), ...fit(redacted, cols - 1, theme.selected)] : [c(theme.text, " "), ...fit(redacted, cols - 1)];
    }));
  }
  private renderSide(screen: Screen) {
    const show = this.showSide(); this.side.visible = show; if (!show) return;
    const row = this.currentRows[this.selected];
    const target: unknown = row?.type === "text" || row?.type === "docker-storage" ? screen.detail : row?.value ?? screen.detail;
    const out: Line[] = [];
    const field = (label: string, value: string | Line, col = theme.text) => { out.push([c(theme.muted, label)]); out.push(typeof value === "string" ? [c(col, value)] : value); };
    const section = (t: string) => { out.push([]); out.push([b(theme.accent, t.toUpperCase())]); };
    if (target && typeof target === "object" && "kind" in target) {
      const r = target as Resource;
      out.push([b(theme.text, r.name)]); out.push(badge(r.status));
      field("Kind", r.kind); field("Owner", r.owner ? r.owner.kind : "none", r.owner ? theme.text : theme.muted);
      if (r.ports.length) field("Ports", r.ports.join("\n"), theme.info);
      field("CPU / Memory", `${r.cpu ?? "unavailable"} · ${r.memory ?? "unavailable"}`);
      section("Associations"); r.associations.length ? r.associations.forEach(a => out.push([c(stateColor(a), `${a.state} `), c(theme.text, a.project.split("/").at(-1)!)])) : out.push([c(theme.muted, "Unassigned")]);
    } else if (target && typeof target === "object" && "url" in target) {
      const s = target as Site, [hc, ht] = httpTone(s);
      out.push([b(theme.secondary, s.url)]); out.push(badge(s.availability));
      field("Scope", s.scope, theme.accent); field("HTTP", ht, hc); field("Backend", s.backend ?? "unknown");
      section("Chain"); s.chain.forEach((hop, i) => out.push([c(theme.faint, i ? "  ↳ " : "  "), c(theme.text, hop)]));
      section("Associations"); s.associations.length ? s.associations.forEach(a => out.push([c(stateColor(a), `${a.state} `), c(theme.text, a.project.split("/").at(-1)!)])) : out.push([c(theme.muted, "Unassigned")]);
    } else if (target && typeof target === "object" && "worktrees" in target) {
      const p = target as Project;
      const rs = this.store.resources.filter(r => r.associations.some(a => a.project === p.id));
      out.push([b(theme.primary, p.name)]); field("Path", p.path.replace(homedir(), "~")); field("Git", p.git);
      section(`Worktrees · ${p.worktrees.length}`); p.worktrees.forEach(w => out.push([c(theme.faint, "⎇ "), c(theme.text, w.replace(homedir(), "~"))]));
      section(`Resources · ${rs.length}`); rs.slice(0, 12).forEach(r => out.push([...badge(r.status.split(" ")[0]), c(theme.text, ` ${r.name}`)]));
    } else if (typeof target === "string") {
      out.push([b(theme.text, target.split("/").at(-1) || target)]); field("Path", target.replace(homedir(), "~"));
      const scan = this.onStorage?.().find(r => r.value === target); field("Last scan", scan ? scan.text : "never · press s", scan ? theme.text : theme.muted);
    } else {
      out.push([b(theme.text, "Collectors")]);
      for (const [name, s] of Object.entries(this.store.sources)) { out.push([...badge(s.state), c(theme.text, `  ${name}`)]); }
      section("Discovery"); for (const [name, s] of [["Projects", this.store.projects], ["Sites", this.store.sites], ["Filesystems", this.store.disks]] as const) out.push([...badge(s.state), c(theme.text, `  ${name}`)]);
    }
    this.sideText.content = styled(out.map(line => line.map(chunk => ({ ...chunk, text: redact(chunk.text) }))));
  }
  private renderFooter(W: number) {
    const cols = W - 2;
    const panel = this.explanation ?? this.panel;
    const hints = panel ? [
      ...(!this.explanation ? [{ key: "e", label: "explain" }] : []),
      ...(panel.confirm ? [{ key: "y", label: "confirm" }] : []), { key: "esc", label: panel.confirm ? "cancel" : "close" },
      { key: "↑↓", label: "scroll" }, { key: "c", label: "cancel command" }, { key: "q", label: "quit" },
    ] : this.palette ? [{ key: "↑↓", label: "select" }, { key: "⏎", label: "run" }, { key: "esc", label: "close" }]
      : this.searching ? [{ key: "⏎", label: "apply" }, { key: "esc", label: "clear" }] : this.hints().filter(h => !["palette", "help"].includes(h.name));
    // Palette and help stay pinned right so every other shortcut remains discoverable.
    const pinned: Line = panel || this.palette || this.searching ? [] : [b(theme.text, "ctrl+p"), c(theme.muted, " commands  "), b(theme.text, "?"), c(theme.muted, " help")];
    const line: Line = [];
    for (const h of hints) {
      const chunk = [b(theme.text, h.key), c(theme.muted, ` ${h.label}   `)];
      if (width(line) + width(chunk) + width(pinned) > cols) break;
      line.push(...chunk);
    }
    const first = width(line) + width(pinned) > cols ? fit(pinned, cols) : [...line, c(theme.text, " ".repeat(cols - width(line) - width(pinned))), ...pinned];
    this.footer.content = styled([first, fit([c(theme.faint, "│ "), c(theme.muted, redact(this.notice))], cols)]);
  }
  private renderModal(W: number, H: number) {
    if (!this.panel && !this.explanation && !this.palette) { this.modal.visible = false; return; }
    const mw = Math.min(W - 4, this.palette ? 64 : 110), inner = Math.max(8, mw - 4);
    const maxH = Math.max(6, H - 4);
    let body: Line[], footer: Line, title: string;
    if (this.palette) {
      const items = this.paletteItems(), visible = Math.max(1, Math.min(items.length, maxH - 5));
      const start = Math.max(0, Math.min(this.palette.index - visible + 1, items.length - visible));
      title = " Commands ";
      body = [[c(theme.primary, "> "), c(theme.text, this.palette.query), c(theme.primary, "▏")], [],
        ...(items.length ? items.slice(start, start + visible).map((item, i) => {
          const active = start + i === this.palette!.index;
          const line = [c(active ? theme.text : theme.text, item.label), c(theme.text, " ".repeat(Math.max(1, inner - item.label.length - item.key.length - 1))), c(theme.muted, item.key)];
          return active ? fit(line, inner, theme.selected) : fit(line, inner);
        }) : [[c(theme.muted, "No matching commands")]])];
      footer = [b(theme.text, "⏎"), c(theme.muted, " run   "), b(theme.text, "↑↓"), c(theme.muted, " select   "), b(theme.text, "esc"), c(theme.muted, " close")];
    } else {
      const panel = (this.explanation ?? this.panel)!;
      const wrapped = redact(panel.text).split("\n").flatMap(line => {
        const chars = [...line]; if (!chars.length) return [""]; const result = []; for (let i = 0; i < chars.length; i += inner) result.push(chars.slice(i, i + inner).join("")); return result;
      });
      const visible = Math.max(1, Math.min(wrapped.length, maxH - 4));
      const scroll = Math.min(this.explanation ? this.explanationScroll : this.panelScroll, Math.max(0, wrapped.length - visible));
      if (this.explanation) this.explanationScroll = scroll; else this.panelScroll = scroll;
      title = ` ${panel.title} `;
      body = wrapped.slice(scroll, scroll + visible).map(outputLine);
      const more = wrapped.length > visible ? `${scroll + 1}–${scroll + visible} of ${wrapped.length}` : "";
      const keys: Line = panel.confirm
        ? [bold(bg(theme.warning)(fg(theme.bg)(" CONFIRM "))), c(theme.text, "  "), b(theme.text, "y"), c(theme.muted, " run this exact command   "), b(theme.text, "esc"), c(theme.muted, " cancel")]
        : [b(theme.text, "esc"), c(theme.muted, " close   "), b(theme.text, "↑↓"), c(theme.muted, " scroll   "), b(theme.text, "c"), c(theme.muted, " cancel running")];
      footer = [...fit(keys, Math.max(1, inner - more.length - 1)), c(theme.text, " ".repeat(Math.max(1, inner - Math.min(width(keys), inner - more.length - 1) - more.length))), c(theme.muted, more)];
    }
    const mh = Math.min(maxH, body.length + 4);
    this.modal.visible = true;
    this.modal.title = title; this.modal.borderColor = !this.explanation && this.panel?.confirm ? theme.warning : theme.primary; this.modal.titleColor = this.modal.borderColor;
    this.modal.width = mw; this.modal.height = mh;
    this.modal.left = Math.max(0, Math.floor((W - mw) / 2)); this.modal.top = Math.max(0, Math.floor((H - mh) / 3));
    this.modalText.content = styled(body);
    this.modalFooter.content = styled([footer]);
  }
}
/** Light syntax colouring for command previews and output. */
function outputLine(line: string): Line {
  if (/^(stdout|stderr):$/.test(line)) return [b(line === "stderr:" ? theme.warning : theme.secondary, line)];
  if (/^Exit: 0\b/.test(line)) return [c(theme.success, "✓ "), c(theme.success, line)];
  if (/^Exit:/.test(line)) return [c(theme.error, "✕ "), c(theme.error, line)];
  const label = line.match(/^(Target|Scope|Command|Observed after refresh):(.*)$/);
  if (label) return [b(theme.primary, `${label[1]}:`), c(theme.text, label[2])];
  if (/^(docker|systemctl|journalctl|du|curl|xdg-open|kill)\b/.test(line)) return [c(theme.primary, "$ "), c(theme.info, line)];
  if (/PARTIAL|STALE|unavailable|denied/i.test(line)) return [c(theme.warning, line)];
  if (/^\S.*$/.test(line) && /^[A-Z][A-Za-z ]+$/.test(line)) return [b(theme.accent, line)];
  return [c(theme.text, line)];
}
export async function startUI(store: Store, fixture = false) {
  const renderer = await createCliRenderer({ exitOnCtrlC: false, backgroundColor: theme.bg, useMouse: false });
  const ui = new Dashboard(renderer, store, fixture);
  process.once("SIGTERM", () => ui.close()); process.once("SIGINT", () => ui.close());
  return ui;
}
