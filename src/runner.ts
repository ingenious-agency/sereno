import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";

export interface Command { file: string; args: string[]; cwd?: string; timeout?: number; limit?: number; stdin?: string; env?: Record<string, string | undefined> }
export interface Result { stdout: string; stderr: string; code: number | null; signal?: string; problem?: string; truncated: boolean; duration: number }
export type Runner = (command: Command, signal?: AbortSignal, progress?: (bytes: number) => void) => Promise<Result>;

// Strip terminal control sequences before any external text reaches the renderer.
export function clean(text: string): string {
  return text.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
}
export function redact(text: string): string {
  return clean(text)
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g, "[redacted private key]")
    .replace(/(authorization\s*[:=]\s*)(?:Bearer|Basic)?\s*[^\r\n]+/gi, "$1[redacted]")
    .replace(/((?:password|passwd|secret|token|api[_-]?key|cookie|credential)[\w-]*["']?\s*[:=]\s*)[^\s,;]+/gi, "$1[redacted]")
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/g, "$1[redacted]@")
    .replace(/(https?:\/\/[^\s?#]+)[?#][^\s]*/g, "$1?[redacted]");
}
export function safeUrl(value: string): string {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error("Sites must use HTTP(S) without credentials, query strings or fragments");
  return url.toString();
}
export const displayCommand = (c: Command) => [c.file, ...c.args].map(x => /^[\w/.:=@,-]+$/.test(x) ? x : JSON.stringify(x)).join(" ") + (c.cwd ? `  (cwd: ${c.cwd})` : "");

export const run: Runner = async (command, signal, progress) => {
  if (command.cwd) {
    try { if (!(await stat(command.cwd)).isDirectory()) throw new Error("not a directory"); }
    catch (error) { return { stdout: "", stderr: "", code: null, problem: `Working directory unavailable: ${command.cwd}: ${(error as Error).message}`, truncated: false, duration: 0 }; }
  }
  return new Promise(resolve => {
  const start = Date.now();
  if (signal?.aborted) return resolve({ stdout: "", stderr: "", code: null, problem: "cancelled", truncated: false, duration: 0 });
  const child = spawn(command.file, command.args, {
    cwd: command.cwd, stdio: [command.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"], detached: true,
    env: { ...process.env, LC_ALL: "C", NO_COLOR: "1", SYSTEMD_COLORS: "0", SYSTEMD_PAGER: "cat", GIT_TERMINAL_PROMPT: "0", ...command.env },
  });
  const chunks: Buffer[][] = [[], []];
  let size = 0, truncated = false, problem: string | undefined, killTimer: NodeJS.Timeout | undefined;
  const stop = (reason: string) => {
    if (problem) return;
    problem = reason;
    try { if (child.pid) process.kill(-child.pid, "SIGTERM"); } catch { /* Already exited. */ }
    killTimer = setTimeout(() => { try { if (child.pid) process.kill(-child.pid, "SIGKILL"); } catch { /* Already exited. */ } }, 500);
  };
  const abort = () => stop("cancelled");
  signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => stop("timeout"), command.timeout ?? 12000);
  [child.stdout!, child.stderr!].forEach((stream, i) => stream.on("data", (chunk: Buffer) => {
    const remaining = Math.max(0, (command.limit ?? 1024 * 1024) - size);
    chunks[i].push(chunk.subarray(0, remaining)); size += chunk.length;
    progress?.(size);
    if (chunk.length > remaining) { truncated = true; stop("output limit reached"); }
  }));
  child.on("error", error => { problem = error.message; });
  if (child.stdin) {
    // Early CLI failures can close stdin before the prompt has been written.
    child.stdin.on("error", error => { if ((error as NodeJS.ErrnoException).code !== "EPIPE") stop(error.message); });
    child.stdin.end(command.stdin);
  }
  child.on("close", (code, sig) => {
    clearTimeout(timer); if (killTimer) clearTimeout(killTimer); signal?.removeEventListener("abort", abort);
    resolve({ stdout: Buffer.concat(chunks[0]).toString(), stderr: Buffer.concat(chunks[1]).toString(), code, signal: sig ?? undefined, problem, truncated, duration: Date.now() - start });
  });
  });
};
export function failureHint(result: Result): string {
  if (result.code === 0 && !result.problem) return "";
  const detail = `${result.problem ?? ""}\n${result.stderr}`;
  if (/permission denied|access denied|EACCES|EPERM|authentication.*required|not authorized/i.test(detail)) return "Access denied. Check Docker socket group membership or the system/user service's authorization. Sereno never escalates privileges.";
  if (/Working directory unavailable|no such file|ENOENT/i.test(detail)) return "A command or required path is missing. Check the executable and the paths shown above; this is not evidence of a permissions failure.";
  return "The operation did not complete successfully. See the command, stderr and termination reason above.";
}
export function requireOutput(result: Result): string {
  if (result.code !== 0 || result.problem || result.truncated) throw new Error(redact(result.problem ?? result.stderr.trim() ?? `exit ${result.code}`) || `exit ${result.code}`);
  return result.stdout;
}
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const output: R[] = new Array(items.length); let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const i = next++; output[i] = await fn(items[i]); }
  }));
  return output;
}
