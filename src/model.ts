export type Health = "loading" | "ready" | "empty" | "partial" | "unavailable" | "error";
export interface Slice<T> { state: Health; data: T; at?: number; message?: string; refreshing?: boolean }
export interface Project { id: string; name: string; path: string; worktrees: string[]; git: string }
export interface Association { project: string; state: "Detected" | "Suggested" | "Assigned"; reason: string }
export interface Owner {
  kind: "docker" | "compose" | "systemd" | "process";
  id: string; user?: boolean; project?: string; service?: string; directory?: string; files?: string[];
}
export interface Resource {
  id: string; kind: "container" | "service" | "process" | "listener";
  name: string; status: string; paths: string[]; associations: Association[];
  owner?: Owner; ports: string[]; related: string[];
  cpu?: string; memory?: string; pid?: number;
  metadata: Record<string, string>;
}
export type Scope = "localhost" | "LAN" | "tailnet" | "public" | "unknown";
export interface Site {
  id: string; url: string; scope: Scope; source: string; backend?: string;
  chain: string[]; configured: boolean; availability: string; associations: Association[];
  namespace?: string;
  resourceIds: string[]; check?: { at: number; status?: number; error?: string };
}
export interface Disk { id: string; mounts: string[]; source: string; type: string; total?: number; used?: number; available?: number }
export interface Overview {
  hostname: string; os: string; kernel: string; uptime: number; cpu: string;
  threads: number; cores?: number; utilization?: number; load: number[];
  memory?: { total: number; used: number; available: number; swapTotal: number; swapUsed: number };
  temperatures: string[];
}
export interface Config {
  explain?: { provider: "codex" | "ollama"; model?: string };
  projectRoots: string[];
  mappings: { resource: string; projects: string[] }[];
  sites: { url: string; scope?: Scope; backend?: string; projects?: string[] }[];
}
export interface Scan { path: string; at: number; state: Health; entries: { path: string; bytes: number }[]; message: string }
export const empty = <T>(data: T): Slice<T> => ({ state: "loading", data });
export const bytes = (n?: number) => n === undefined || !Number.isFinite(n) ? "unavailable" : n < 1024 ? `${n} B` : `${(n / 1024 ** Math.min(4, Math.floor(Math.log(n) / Math.log(1024)))).toFixed(1)} ${["B", "KiB", "MiB", "GiB", "TiB"][Math.min(4, Math.floor(Math.log(n) / Math.log(1024)))]}`;
