import { readFile, mkdir, writeFile, rename } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve, dirname } from "node:path";
import { safeUrl } from "./runner.ts";
import type { Config, Relationship } from "./model.ts";
import { decodeOrganization } from "./domain-schema.ts";
import type { Organization } from "./domain.ts";

export const expand = (p: string) => resolve(p.startsWith("~/") ? homedir() + p.slice(1) : p);
export const configPath = process.env.SERENO_CONFIG ? expand(process.env.SERENO_CONFIG) : `${process.env.XDG_CONFIG_HOME || homedir() + "/.config"}/sereno/config.json`;
export async function loadConfig(path = configPath): Promise<Config> {
  let raw;
  try { raw = JSON.parse(await readFile(path, "utf8")); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") raw = {}; else throw e; }
  const config: Config = { projectRoots: raw.projectRoots ?? ["~/Work/Projects"], mappings: raw.mappings ?? [], sites: raw.sites ?? [], ...(raw.explain === undefined ? {} : { explain: raw.explain }) };
  if (raw.organization !== undefined) config.organization = decodeOrganization(raw.organization);
  if (raw.encargado !== undefined) {
    if (!raw.encargado || typeof raw.encargado !== "object" || (raw.encargado.enabled !== undefined && typeof raw.encargado.enabled !== "boolean") || (raw.encargado.socket !== undefined && typeof raw.encargado.socket !== "string")) throw new Error("Invalid encargado configuration");
    config.encargado = { ...raw.encargado, ...(raw.encargado.socket ? { socket: expand(raw.encargado.socket) } : {}) };
  }
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
    if (m.relationships !== undefined) {
      if (!Array.isArray(m.relationships)) throw new Error("Invalid mapping relationships");
      const seen = new Set<string>();
      for (const r of m.relationships) {
        if (!r || typeof r.project !== "string" || (r.role !== undefined && !["workload", "dependency", "tooling"].includes(r.role)) || (r.purpose !== undefined && typeof r.purpose !== "string")) throw new Error("Invalid mapping relationship");
        r.project = expand(r.project);
        if (!m.projects.includes(r.project) || seen.has(r.project)) throw new Error("Relationship must name a unique mapped project");
        seen.add(r.project);
      }
    }
  }
  for (const s of config.sites) {
    s.url = safeUrl(s.url); if (s.backend) s.backend = safeUrl(s.backend);
    if (s.scope && !["localhost", "LAN", "tailnet", "public", "unknown"].includes(s.scope)) throw new Error("Invalid site scope");
    if (s.projects && (!Array.isArray(s.projects) || !s.projects.every(p => typeof p === "string"))) throw new Error("Invalid site projects");
    s.projects = s.projects?.map(expand);
  }
  return config;
}
export async function saveMapping(config: Config, resource: string, projects: string[], path = configPath, relationships?: Relationship[]) {
  const kept = (relationships ?? config.mappings.find(m => m.resource === resource)?.relationships)?.filter(r => projects.includes(r.project));
  const next = { ...config, mappings: [...config.mappings.filter(m => m.resource !== resource), { resource, projects, ...(kept?.length ? { relationships: kept } : {}) }] };
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
  await rename(temporary, path);
  config.mappings = next.mappings;
}
export async function saveOrganization(config: Config, organization: Organization, path = configPath) {
  const validated = decodeOrganization(organization);
  const definition = ({ id, name, parent, labels, description, actions, details }: import("./domain.ts").Node) => ({ id, name, parent, labels, ...(description === undefined ? {} : { description }), actions, details });
  const saved = { version: 1, groups: validated.groups.map(definition), resources: validated.resources.map(r => ({ ...definition(r), type: r.type, ...(r.probe ? { probe: r.probe } : {}) })), placements: validated.placements };
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify({ ...config, organization: saved }, null, 2) + "\n", { mode: 0o600 });
  await rename(temporary, path); config.organization = validated;
}
