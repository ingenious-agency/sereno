import { readFile, mkdir, writeFile, rename } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve, dirname } from "node:path";
import { safeUrl } from "./runner.ts";
import type { Config } from "./model.ts";

export const expand = (p: string) => resolve(p.startsWith("~/") ? homedir() + p.slice(1) : p);
export const configPath = process.env.SERENO_CONFIG ? expand(process.env.SERENO_CONFIG) : `${process.env.XDG_CONFIG_HOME || homedir() + "/.config"}/sereno/config.json`;
export async function loadConfig(path = configPath): Promise<Config> {
  let raw;
  try { raw = JSON.parse(await readFile(path, "utf8")); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") raw = {}; else throw e; }
  const config: Config = { projectRoots: raw.projectRoots ?? ["~/Work/Projects"], mappings: raw.mappings ?? [], sites: raw.sites ?? [], ...(raw.explain === undefined ? {} : { explain: raw.explain }) };
  if (config.explain) {
    if (!["codex", "ollama"].includes(config.explain.provider)) throw new Error("explain.provider must be codex or ollama");
    if (config.explain.model !== undefined && (typeof config.explain.model !== "string" || !config.explain.model.trim() || config.explain.model.startsWith("-") || /[\r\n\0]/.test(config.explain.model))) throw new Error("Invalid explain.model");
    if (config.explain.provider === "ollama" && !config.explain.model) throw new Error("explain.model is required for Ollama (choose an installed local model)");
  } else if (raw.explain !== undefined) throw new Error("Invalid explain configuration");
  if (!Array.isArray(config.projectRoots) || !config.projectRoots.every(p => typeof p === "string") || !Array.isArray(config.mappings) || !Array.isArray(config.sites)) throw new Error("Invalid config arrays");
  config.projectRoots = config.projectRoots.map(expand);
  for (const m of config.mappings) {
    if (typeof m.resource !== "string" || !Array.isArray(m.projects) || !m.projects.every(p => typeof p === "string")) throw new Error("Invalid resource mapping");
    m.projects = m.projects.map(expand);
  }
  for (const s of config.sites) {
    s.url = safeUrl(s.url); if (s.backend) s.backend = safeUrl(s.backend);
    if (s.scope && !["localhost", "LAN", "tailnet", "public", "unknown"].includes(s.scope)) throw new Error("Invalid site scope");
    if (s.projects && (!Array.isArray(s.projects) || !s.projects.every(p => typeof p === "string"))) throw new Error("Invalid site projects");
    s.projects = s.projects?.map(expand);
  }
  return config;
}
export async function saveMapping(config: Config, resource: string, projects: string[], path = configPath) {
  const next = { ...config, mappings: [...config.mappings.filter(m => m.resource !== resource), { resource, projects }] };
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
  await rename(temporary, path);
  config.mappings = next.mappings;
}
