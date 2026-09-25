// Purpose: P3-2 — lifecycle of the engine (the local proxy): one instance per machine, `ensure` starts it in the
// background when it is not running, and it exits by itself once no Codex process is left.
// Input: the port; process lists from `tasklist` on Windows. Output: health checks, a detached engine process.

import { execFile, spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const ENGINE_SERVICE = "codex-attachment-manager";
export const DEFAULT_PORT = 17891;
const here = dirname(fileURLToPath(import.meta.url));

export type Health = { ok: true; service: string; pid: number; startedAt: string; port: number };

export function isEngineHealth(value: unknown): value is Health {
  const health = value as Partial<Health> | null;
  return !!health && health.ok === true && health.service === ENGINE_SERVICE && typeof health.pid === "number";
}

// Loopback only, and never through a system proxy: plain http.get on 127.0.0.1.
export async function engineHealth(port = DEFAULT_PORT, timeoutMs = 800): Promise<Health | null> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/__cam/health`, { signal: AbortSignal.timeout(timeoutMs) });
    const body = await response.json();
    return isEngineHealth(body) ? body : null;
  } catch {
    return null;
  }
}

// Detached and hidden, so it outlives whoever asked for it (a plugin server instance, the CLI).
export function spawnEngine(port = DEFAULT_PORT, extraArgs: string[] = []): number | undefined {
  const child = spawn(process.execPath, [join(here, "proxy.ts"), "--port", String(port), ...extraArgs], { detached: true, stdio: "ignore", windowsHide: true });
  child.unref();
  return child.pid;
}

export async function ensureEngine(options: { port?: number; waitMs?: number; extraArgs?: string[] } = {}): Promise<{ state: "running" | "started" | "failed"; health: Health | null }> {
  const port = options.port ?? DEFAULT_PORT;
  const existing = await engineHealth(port);
  if (existing) return { state: "running", health: existing };
  spawnEngine(port, options.extraArgs);
  const deadline = Date.now() + (options.waitMs ?? 8000);
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 150));
    const health = await engineHealth(port);
    if (health) return { state: "started", health };
  }
  return { state: "failed", health: null };
}

// `tasklist /FO CSV /NH` prints one quoted CSV row per process, or an INFO line when nothing matches.
export function countCodexProcesses(tasklistCsv: string): number {
  return tasklistCsv.split(/\r?\n/).filter((line) => /^"codex\.exe",/i.test(line.trim())).length;
}

export function listCodexProcesses(): Promise<number> {
  if (process.platform !== "win32") return Promise.resolve(1);
  return new Promise((resolve) => {
    execFile("tasklist", ["/FI", "IMAGENAME eq codex.exe", "/FO", "CSV", "/NH"], { windowsHide: true }, (error, stdout) => {
      // If the check itself fails, assume Codex is still there rather than shutting down under it.
      resolve(error ? 1 : countCodexProcesses(stdout));
    });
  });
}

// Exit only after `misses` checks in a row found no Codex, so a Codex restart does not stop the engine.
export function watchForCodex(onGone: () => void, options: { intervalMs?: number; misses?: number; count?: () => Promise<number> } = {}): () => void {
  const count = options.count ?? listCodexProcesses;
  const needed = options.misses ?? 2;
  let missed = 0;
  const timer = setInterval(async () => {
    missed = (await count()) > 0 ? 0 : missed + 1;
    if (missed >= needed) { clearInterval(timer); onGone(); }
  }, options.intervalMs ?? 15_000);
  timer.unref();
  return () => clearInterval(timer);
}
