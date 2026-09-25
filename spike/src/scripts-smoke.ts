// Purpose: v0.1-5 — the one-line install and uninstall scripts, run for real on this platform against a throwaway
// Codex home that already holds the user's own settings: install adds the plugin and points Codex at the engine
// (which starts), uninstall gives back config.toml and .env exactly as they were and removes the plugin. The
// marketplace is this checkout (CAM_SOURCE), so nothing is fetched from GitHub. CI runs it on Windows, macOS and Linux.
// Input: a Codex command line (CODEX_CLI_PATH, a desktop app's copy, or codex on PATH); [--port 17894] for the test
// engine. Output: a JSON summary on stdout; exit code 1 when a check fails.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { findCodexCli } from "../../plugin/src/codexcli.ts";
import { buildOf, engineHealth } from "../../plugin/src/engine.ts";
import { MARKETPLACE, PLUGIN, pluginStatus } from "../../plugin/src/install.ts";

type Json = Record<string, any>;
const root = resolve(import.meta.dirname, "..", "..");
const option = (name: string, fallback: string) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : fallback);
const port = Number(option("--port", "17894"));
const windows = process.platform === "win32";
const eol = windows ? "\r\n" : "\n";

// Done when the script exits, not when its output closes: on Windows the engine it starts inherits the output pipe
// and would hold it open until the engine itself exits.
function run(script: "install" | "uninstall", env: NodeJS.ProcessEnv): Promise<{ ok: boolean; output: string }> {
  const file = join(root, "scripts", windows ? `${script}.ps1` : `${script}.sh`);
  const [command, args] = windows ? ["powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", file]] : ["sh", [file]];
  return new Promise((done) => {
    const child = spawn(command, args, { env, windowsHide: true });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk: Buffer) => { output += chunk.toString("utf8"); });
    child.on("exit", (code) => setTimeout(() => done({ ok: code === 0, output: output.trim() }), 200));
  });
}

async function main(): Promise<boolean> {
  const scratch = mkdtempSync(join(tmpdir(), "cam-scripts-"));
  const [home, data] = ["codex-home", "data"].map((name) => join(scratch, name));
  for (const dir of [home, data]) mkdirSync(dir, { recursive: true });
  const cli = findCodexCli();
  if (!cli) throw new Error("no Codex command line found (set CODEX_CLI_PATH or put codex on PATH)");
  // The user's own settings, in this platform's line endings; they must come back byte for byte.
  const config = ['model = "gpt-6-sol"', "", "[features]", "view_image = true", ""].join(eol);
  const dotenv = `OTHER_SETTING=1${eol}`;
  writeFileSync(join(home, "config.toml"), config);
  writeFileSync(join(home, ".env"), dotenv);
  const env = { ...process.env, CODEX_HOME: home, CAM_DATA_DIR: data, CAM_ENGINE_PORT: String(port), CAM_SOURCE: root, CODEX_CLI_PATH: cli };
  const summary: Json = { platform: process.platform, cli, scratch, checks: {} };
  const checks: Record<string, boolean> = summary.checks;

  const installed = await run("install", env);
  summary.install = installed.output.split(/\r?\n/).slice(-12);
  const afterInstall = readFileSync(join(home, "config.toml"), "utf8");
  const cache = join(home, "plugins", "cache", MARKETPLACE, PLUGIN);
  checks.installScriptSucceeded = installed.ok;
  checks.pluginInstalled = pluginStatus(afterInstall).installed && existsSync(cache);
  checks.pointsAtEngine = afterInstall.includes(`openai_base_url = "http://localhost:${port}/backend-api/codex"`);
  let health = null;
  for (let i = 0; i < 20 && !health; i++) {
    health = await engineHealth(port);
    if (!health) await sleep(250);
  }
  const version = JSON.parse(readFileSync(join(root, "plugin", ".codex-plugin", "plugin.json"), "utf8")).version;
  summary.engine = health ? { pid: health.pid, build: health.build, installedBuild: buildOf(join(cache, version, "src")) } : null;
  checks.engineFromInstalledCopy = !!health && health.build === buildOf(join(cache, version, "src"));

  const removed = await run("uninstall", env);
  summary.uninstall = removed.output.split(/\r?\n/).slice(-8);
  checks.uninstallScriptSucceeded = removed.ok;
  const afterUninstall = readFileSync(join(home, "config.toml"), "utf8");
  // Codex's own command line writes config.toml with LF when it adds or removes the plugin's entries, so line endings
  // are compared loosely here; the plugin's own blocks keep them (unit tests check that byte for byte).
  const lf = (text: string) => text.replaceAll("\r\n", "\n");
  summary.configAfterUninstall = afterUninstall === config ? "identical" : lf(afterUninstall) === lf(config) ? "identical apart from line endings" : afterUninstall;
  checks.configRestored = lf(afterUninstall) === lf(config);
  checks.dotenvRestored = readFileSync(join(home, ".env"), "utf8") === dotenv;
  checks.pluginRemoved = !pluginStatus(afterUninstall).installed && !existsSync(cache);

  if (health) try { process.kill(health.pid); } catch { /* already gone */ }
  const ok = Object.values(checks).every(Boolean);
  console.log(JSON.stringify({ ok, ...summary }, null, 2));
  return ok;
}

if (!(await main())) process.exitCode = 1;
