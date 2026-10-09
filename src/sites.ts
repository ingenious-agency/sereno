import { clean, requireOutput, safeUrl, type Runner } from "./runner.ts";
import type { Association, Config, Resource, Site } from "./model.ts";

export function tailscaleSites(raw: any, source: string): Site[] {
  const sites: Site[] = [];
  const read = (config: any, label: string) => {
    for (const [host, web] of Object.entries(config.Web ?? {}) as [string, any][]) {
      for (const [path, handler] of Object.entries(web.Handlers ?? {}) as [string, any][]) {
        const port = host.match(/:(\d+)$/)?.[1] ?? "443";
        const scheme = config.TCP?.[port]?.HTTPS ? "https" : "http";
        const url = safeUrl(`${scheme}://${host}${path}`);
        sites.push({ id: `site:${label}:${url}`, url, scope: config.AllowFunnel?.[host] || raw.AllowFunnel?.[host] ? "public" : "tailnet", source: label,
          backend: handler.Proxy, chain: [label, handler.Proxy ?? "static/text handler"], configured: true, availability: handler.Proxy ? "unknown" : "static handler; no backend", associations: [], resourceIds: [] });
      }
    }
    for (const [name, service] of Object.entries(config.Services ?? {})) read(service, `${label}/${name}`);
  };
  read(raw, source); return sites;
}
export interface ProxyRoute { service: string; host: string; path: string; target: string; state: string; tls: boolean; proxy: string }
export function parseKamal(text: string, proxy: string): ProxyRoute[] {
  const lines = clean(text).trim().split("\n").filter(Boolean);
  if (!lines.length) return [];
  if (!/^Service\s+Host\s+Path\s+Target\s+State\s+TLS/.test(lines[0])) throw new Error("Unsupported kamal-proxy list format");
  return lines.slice(1).map(line => {
    const [service, host, path, target, state, tls] = line.trim().split(/\s+/);
    if (!tls || !target.includes(":")) throw new Error("Unsupported Kamal route row");
    return { service, host, path, target, state, tls: tls === "yes", proxy };
  });
}
export async function discoverSites(run: Runner, resources: Resource[], config: Config, signal?: AbortSignal) {
  const sites: Site[] = [], routes: ProxyRoute[] = [], issues: string[] = [];
  const hosts = [{ source: "tailscale:host", namespace: "host", file: "tailscale", args: ["serve", "status", "--json"] },
    ...resources.filter(r => r.kind === "container" && /(^|\/)tailscale(?:\/tailscale)?[:@]/.test(r.metadata.image)).map(r => ({ source: `tailscale:${r.name}`, namespace: r.metadata.networkMode === "host" ? "host" : r.id, file: "docker", args: ["exec", r.owner!.id, "tailscale", "serve", "status", "--json"] }))];
  await Promise.all(hosts.map(async h => {
    try { sites.push(...tailscaleSites(JSON.parse(requireOutput(await run({ file: h.file, args: h.args }, signal))), h.source).map(s => ({ ...s, namespace: h.namespace }))); }
    catch (e) { issues.push(`${h.source}: ${e}`); }
  }));
  await Promise.all(resources.filter(r => r.kind === "container" && /(?:^|\/)kamal-proxy[:@]/.test(r.metadata.image)).map(async proxy => {
    try { routes.push(...parseKamal(requireOutput(await run({ file: "docker", args: ["exec", proxy.owner!.id, "kamal-proxy", "list"] }, signal)), proxy.id)); }
    catch (e) { issues.push(`Kamal ${proxy.name}: ${e}`); }
  }));
  for (const route of routes) {
    // Host matching alone is not enough: verify the front route actually targets this proxy's published port.
    const front = sites.filter(s => (!s.namespace || s.namespace === "host") && new URL(s.url).hostname === route.host && s.backend && backendResources(s.backend, resources).some(r => r.id === route.proxy));
    for (const s of front) {
      s.chain.push(`kamal:${route.service} ${route.path}`, route.target);
      s.resourceIds.push(route.proxy);
      s.backend = `http://${route.target}`;
    }
    if (!front.length) sites.push({ id: `site:kamal:${route.proxy}:${route.host}${route.path}`, url: safeUrl(`${route.tls ? "https" : "http"}://${route.host}${route.path}`), scope: "unknown", source: `kamal-proxy:${route.proxy}`, backend: `http://${route.target}`, chain: [`kamal:${route.service}`, route.target], configured: true, availability: "unknown", associations: [], resourceIds: [route.proxy] });
  }
  for (const manual of config.sites) sites.push({ id: `site:manual:${manual.url}`, url: manual.url, scope: manual.scope ?? "unknown", source: "manual config (route not verified)", backend: manual.backend, chain: [manual.backend ?? "unknown"], configured: false, availability: "unknown", resourceIds: [], associations: (manual.projects ?? []).map(project => ({ project, state: "Assigned", reason: "Manual site configuration" })) });
  return { sites: associateSites(sites, resources, config), issues };
}
export function backendResources(backend: string, resources: Resource[]): Resource[] {
  let url: URL; try { url = new URL(backend.includes("://") ? backend : `http://${backend}`); } catch { return []; }
  const host = url.hostname.replace(/^\[|\]$/g, ""), port = url.port || (url.protocol === "https:" ? "443" : "80");
  const local = ["localhost", "127.0.0.1", "::1"].includes(host);
  const matches: Resource[] = [];
  for (const r of resources) {
    if (r.kind === "container" && (r.name === host || (host.length >= 12 && r.owner!.id.startsWith(host)) || Object.entries(r.metadata).some(([key, value]) => key.startsWith("network.") && value === host))) matches.push(r);
    if (local && r.kind !== "service" && r.ports.some(binding => {
      if (binding.endsWith("/udp")) return false;
      const address = binding.split("->")[0]; const colon = address.lastIndexOf(":");
      const ip = address.slice(0, colon).replace(/^\[|\]$/g, "");
      return address.slice(colon + 1) === port && ([host, "0.0.0.0", "::", "*"].includes(ip) || (host === "localhost" && ["127.0.0.1", "::1"].includes(ip)));
    })) matches.push(r);
  }
  return [...new Map(matches.map(r => [r.id, r])).values()];
}
export function associateSites(sites: Site[], resources: Resource[], config: Config): Site[] {
  return sites.map(site => {
    const backends = site.backend && (!site.namespace || site.namespace === "host") ? backendResources(site.backend, resources) : [];
    const associations: Association[] = [...site.associations];
    for (const r of backends) for (const a of r.associations) if (!associations.some(x => x.project === a.project)) associations.push({ ...a, reason: `Backend ${r.id}: ${a.reason}` });
    const override = config.mappings.find(m => m.resource === site.id);
    const availability = !site.backend ? site.availability : backends.some(r => r.kind === "listener") ? "listening (local socket observed)" : backends.some(r => r.kind === "container" && r.status === "running") ? "container running; listener unverified" : backends.some(r => r.kind === "container") ? "container not running" : "unknown / listener not observed";
    return { ...site, availability, resourceIds: [...new Set([...site.resourceIds, ...backends.map(r => r.id)])], associations: override ? override.projects.map(project => ({ ...override.relationships?.find(r => r.project === project), project, state: "Assigned" as const, reason: "Explicit configuration override" })) : associations };
  });
}
