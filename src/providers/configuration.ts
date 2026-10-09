import type { Organization, ProviderSnapshot } from "../domain.ts";
import { httpCommand } from "../actions.ts";
import { redact, safeUrl, type Runner } from "../runner.ts";

/** Configuration contributes ordinary resources, with optional live status probes. */
export async function configurationSnapshot(organization: Organization, runner: Runner, signal: AbortSignal): Promise<ProviderSnapshot> {
  const nodes = await Promise.all(organization.resources.map(async resource => {
    let node = resource;
    if (node.type === "website" && node.details.URL && !node.actions.length) {
      const url = safeUrl(node.details.URL);
      node = { ...node, actions: [
        { id: "open", label: "Open", description: `Open ${url}`, confirm: false, execution: { type: "command", command: { file: "xdg-open", args: [url], timeout: 10000 } } },
        { id: "check", label: "Check HTTP", description: "One HTTP HEAD request; redirects are not followed", confirm: false, execution: { type: "command", command: httpCommand({ id: node.id, url, scope: "unknown", source: "config", chain: [], configured: false, availability: "unknown", associations: [], resourceIds: [] }) } },
      ] };
    }
    if (!node.probe) return node;
    const result = await runner(node.probe, signal);
    const available = result.code !== null && !result.problem && !result.truncated;
    return { ...node, status: available ? redact(result.stdout.trim()).slice(0, 512) || (result.code === 0 ? "ready" : `failed (exit ${result.code})`) : "unavailable", available, observedAt: Date.now() };
  }));
  return { id: "config", state: "ready", nodes, at: Date.now() };
}
