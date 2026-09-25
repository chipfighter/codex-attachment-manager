// Purpose: P5 — find and run Codex's own command line, which registers marketplaces and installs or removes plugins
// (copying them into Codex's plugin cache). The desktop app ships one; a codex on PATH is the fallback.
// Input: CODEX_CLI_PATH, the desktop app's folder (%LOCALAPPDATA%\OpenAI\Codex\bin\<build>\codex.exe), or PATH.
// Output: the command's exit status and its combined output (Codex prints no secrets for these commands).

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function findCodexCli(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.CODEX_CLI_PATH && existsSync(env.CODEX_CLI_PATH)) return env.CODEX_CLI_PATH;
  if (process.platform === "win32") {
    // The desktop app keeps one folder per build; the newest one belongs to the app that runs now.
    const root = join(env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "OpenAI", "Codex", "bin");
    const builds = existsSync(root) ? readdirSync(root).map((name) => join(root, name, "codex.exe")).filter((file) => existsSync(file)) : [];
    builds.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
    if (builds.length) return builds[0];
  }
  try {
    const found = execFileSync(process.platform === "win32" ? "where" : "which", ["codex"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return found.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? null;
  } catch {
    return null;
  }
}

export function runCodex(cli: string, args: string[]): { ok: boolean; output: string } {
  // An npm-installed codex on Windows is a .cmd shim, which only cmd.exe can start.
  const shim = /\.cmd$/i.test(cli);
  const result = spawnSync(shim ? "cmd.exe" : cli, shim ? ["/d", "/s", "/c", cli, ...args] : args, { encoding: "utf8", windowsHide: true });
  return { ok: result.status === 0, output: `${result.stdout ?? ""}${result.stderr ?? ""}`.trim() };
}
