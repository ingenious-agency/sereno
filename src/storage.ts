import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { Scan } from "./model.ts";
import { redact, type Command, type Runner } from "./runner.ts";

export function parseDu(text: string) {
  return text
    .split("\0")
    .filter(Boolean)
    .map((record) => {
      const match = record.match(/^(\d+)\t([\s\S]+)$/);
      if (!match) throw new Error("Unrecognized or truncated du record");
      return { path: match[2], bytes: Number(match[1]) };
    });
}
export const scanCommand = (path: string): Command => ({
  file: "du",
  args: ["--block-size=1", "--max-depth=1", "--null", "--", path],
  timeout: 120000,
  limit: 2 * 1024 * 1024,
});
export async function scanFolder(
  path: string,
  runner: Runner,
  signal?: AbortSignal,
  progress?: (bytes: number) => void,
): Promise<Scan> {
  const result = await runner(scanCommand(path), signal, progress);
  const partial = result.code !== 0 || Boolean(result.problem) || result.truncated;
  // On cancellation retain only complete records; never treat the incomplete total as a complete scan.
  const complete = result.stdout.slice(0, result.stdout.lastIndexOf("\0") + 1);
  const entries = parseDu(complete).sort((a, b) => b.bytes - a.bytes);
  return {
    path,
    at: Date.now(),
    state: partial ? (entries.length ? "partial" : "unavailable") : "ready",
    entries,
    message: redact(
      `${partial ? "PARTIAL scan; totals incomplete. " : "Completed. "}${result.problem ?? ""} ${result.stderr} Exit: ${result.code ?? "none"}. du allocated file bytes can overlap and differ from physical usage (compression/reflinks/snapshots).`,
    ),
  };
}
export async function childFolders(path: string) {
  return (await readdir(path, { withFileTypes: true }))
    .filter((e) => e.isDirectory())
    .map((e) => join(path, e.name))
    .sort();
}
