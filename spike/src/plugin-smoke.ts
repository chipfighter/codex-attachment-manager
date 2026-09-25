// Purpose: v0.1 — the plugin as a user gets it, on any platform. Codex's own command line installs it from this
// checkout into a throwaway Codex home; a Codex app-server then starts a thread, which must bring up the plugin's MCP
// server through .mcp.json and the launcher, list its tools, serve the panel, and start the engine. CI runs this on
// Windows, macOS and Linux, where nobody has tried the plugin by hand. It never touches the real ~/.codex or the
// tool's real data folder, and needs no login.
// Input: a Codex command line (CODEX_CLI_PATH, a desktop app's copy, or codex on PATH); [--port 17893] for the test
// engine. Output: a JSON summary on stdout, exit code 1 when a check fails; the app-server's stderr in the temp folder.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { AppServer, type Notification } from "./appserver.ts";
import { findCodexCli, runCodex } from "../../plugin/src/codexcli.ts";
import { engineHealth, type Health } from "../../plugin/src/engine.ts";
import { MARKETPLACE, PLUGIN, PLUGIN_ID, SERVER_NAME } from "../../plugin/src/install.ts";

type Json = Record<string, any>;
const root = resolve(import.meta.dirname, "..", "..");
const option = (name: string, fallback: string) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : fallback);
const port = Number(option("--port", "17893"));
const version: string = JSON.parse(readFileSync(join(root, "plugin", ".codex-plugin", "plugin.json"), "utf8")).version;
const TOOLS = ["cam_panel", "cam_set_selection", "cam_image"];

async function main(): Promise<boolean> {
  const scratch = mkdtempSync(join(tmpdir(), "cam-smoke-"));
  const [home, data, work] = ["codex-home", "data", "work"].map((name) => join(scratch, name));
  for (const dir of [home, data, work]) mkdirSync(dir, { recursive: true });
  const overrides = { CODEX_HOME: home, CAM_DATA_DIR: data, CAM_ENGINE_PORT: String(port) };
  const cli = findCodexCli();
  if (!cli) throw new Error("no Codex command line found (set CODEX_CLI_PATH or put codex on PATH)");
  const summary: Json = { platform: process.platform, cli, codex: runCodex(cli, ["--version"]).output, scratch, checks: {} };
  const checks: Record<string, boolean> = summary.checks;

  // 1. Installed the way users install it: Codex's command line copies the plugin into its cache.
  const env = { ...process.env, ...overrides };
  const steps = [["plugin", "marketplace", "add", root], ["plugin", "add", PLUGIN_ID]].map((args) => ({ args: args.join(" "), ...runCodex(cli, args, env) }));
  summary.install = steps;
  const cached = join(home, "plugins", "cache", MARKETPLACE, PLUGIN, version);
  checks.installedIntoCache = steps.every((step) => step.ok) && existsSync(join(cached, ".mcp.json"));
  // Codex runs ./scripts/launch itself on macOS and Linux, so the copy must keep the executable bit.
  if (process.platform !== "win32") checks.launcherExecutable = existsSync(join(cached, "scripts", "launch")) && (statSync(join(cached, "scripts", "launch")).mode & 0o111) !== 0;

  // 2. A thread brings the plugin's MCP server up, as in the desktop app.
  const server = new AppServer(cli, [], overrides, join(scratch, "app-server.log"));
  let health: Health | null = null;
  try {
    await server.initialize();
    const { thread } = await server.request<{ thread: Json }>("thread/start", { cwd: work, approvalPolicy: "never", sandbox: "read-only", ephemeral: true });
    const ours = (n: Notification) => n.method === "mcpServer/startupStatus/updated" && String(n.params.name).endsWith(SERVER_NAME);
    const settled = await server.waitFor((n) => ours(n) && n.params.status !== "starting", 90_000).catch(() => null);
    summary.startup = server.notifications.filter(ours).map((n) => ({ name: n.params.name, status: n.params.status, error: n.params.error }));
    checks.serverReady = settled?.params.status === "ready";
    const listed = await server.request<{ data: Json[] }>("mcpServerStatus/list", { threadId: thread.id }, 60_000);
    const status = listed.data.find((entry) => String(entry.name).endsWith(SERVER_NAME));
    summary.server = status ? { name: status.name, pluginId: status.pluginId, serverInfo: status.serverInfo?.name ?? null, tools: Object.keys(status.tools ?? {}), resources: status.resources?.map((r: Json) => r.uri) } : null;
    checks.toolsListed = TOOLS.every((tool) => summary.server?.tools.includes(tool));
    checks.panelListed = !!summary.server?.resources?.includes("ui://codex-attachment-manager/panel.html");

    // 3. The MCP server starts the engine, which answers on loopback.
    for (let i = 0; i < 40 && !health; i++) {
      health = await engineHealth(port);
      if (!health) await sleep(250);
    }
    summary.engine = health ? { pid: health.pid, port: health.port } : null;
    checks.engineStarted = !!health;
  } finally {
    await server.stop();
    // On Windows the engine ends with the MCP server's job; elsewhere it would outlive this test.
    if (health) try { process.kill(health.pid); } catch { /* already gone */ }
  }
  const ok = Object.values(checks).every(Boolean);
  console.log(JSON.stringify({ ok, ...summary }, null, 2));
  return ok;
}

if (!(await main())) process.exitCode = 1;
