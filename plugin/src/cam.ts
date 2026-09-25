// Purpose: the tool's command line. install / uninstall / status set up and remove every managed setting at once;
// list / uncheck / check / check-all work on one thread from the terminal.
// P5: install registers this repository as a plugin marketplace and installs the plugin with Codex's own command line
// (Codex copies it into its plugin cache and starts its MCP server, which keeps the engine running), checks that the
// installed copy starts, and only then points Codex at the engine. uninstall goes the other way round. Either way
// Codex is never left pointed at an engine that nothing would start.
// v0.1-5: setup, run from the copy Codex installed (the install scripts do this after Codex's own command line added
// the plugin), points Codex at the engine and starts it. The settings themselves are switched in setup.ts.
// Input: install [--port N] | setup [--port N] | uninstall | status | list|uncheck|check|check-all <thread id> [IMG-…].
// Output: config.toml (copied to <data dir>/config-backup/ before every change), ~/.codex/.env (never copied or
// printed: it may hold credentials), the plugin cache (through Codex's command line), the selection files, and a
// summary on stdout. Rollouts are only read.

import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { findCodexCli, runCodex } from "./codexcli.ts";
import { codexHome, MCP_BEGIN, noProxyStatus, proxyStatus } from "./codexconfig.ts";
import { buildOf, DEFAULT_PORT, engineHealth, ensureEngine } from "./engine.ts";
import { isEntryPoint } from "./entry.ts";
import { MARKETPLACE, PLUGIN, PLUGIN_ID, planInstall, pluginStatus } from "./install.ts";
import { applySelection, loadPanelState, type PanelState } from "./panel-state.ts";
import { dataDir, selectionDirOf } from "./paths.ts";
import { backupConfig, connectDirectly, readConfig, readEnv, useEngine, userProxyEnv } from "./setup.ts";

type Json = Record<string, any>;
const KIND: Record<string, string> = { upload: "上传", view: "工具查看", generated: "生成", tool: "工具结果" };
// This file lives in <repository>/plugin/src; the repository root is the marketplace.
const repository = resolve(import.meta.dirname, "..", "..");
const pluginVersion = (): string => JSON.parse(readFileSync(resolve(import.meta.dirname, "..", ".codex-plugin", "plugin.json"), "utf8")).version;
export const pluginCacheDir = (version: string) => join(codexHome(), "plugins", "cache", MARKETPLACE, PLUGIN, version);

function table(state: PanelState): string {
  const rows = state.images.map((image) => [
    image.id,
    !image.replaceable ? "锁定" : image.checked ? "勾选" : "取消",
    KIND[image.kind] ?? image.kind,
    image.name ?? "—",
    image.turn ?? "—",
    image.width && image.height ? `${image.width}×${image.height}` : "—",
    `${(image.bytes / 1024).toFixed(0)} KB`,
    image.sameAs.join(",") || "—",
    image.requested ? "模型索要" : "",
  ].join(" | "));
  const mb = (bytes: number) => (bytes / 1e6).toFixed(2);
  return [
    `任务 ${state.threadId}：${state.totals.images} 张图，${state.turns} 轮；取消 ${state.totals.unchecked} 张；勾选的图共 ${mb(state.totals.checkedBytes)} MB（全部勾选时 ${mb(state.totals.allBytes)} MB）`,
    "编号 | 状态 | 来源 | 名称 | 轮次 | 尺寸 | 大小 | 内容相同 | 备注",
    ...rows,
  ].join("\n");
}

// Codex may store the marketplace path with the \\?\ prefix; compare the plain paths, ignoring case on Windows.
const samePath = (a: string, b: string) => {
  const plain = (path: string) => resolve(path.replace(/^\\\\\?\\/, ""));
  return process.platform === "win32" ? plain(a).toLowerCase() === plain(b).toLowerCase() : plain(a) === plain(b);
};

function codex(cli: string, args: string[]): string {
  const { ok, output } = runCodex(cli, args);
  if (!ok) throw new Error(`codex ${args.join(" ")} 失败：${output || "没有输出"}`);
  return output;
}

// How Codex starts the plugin's MCP server (.mcp.json: ./scripts/launch in the plugin folder): on Windows it finds
// launch.cmd, which only cmd.exe runs; on macOS and Linux it runs the shell script itself (so it must be executable).
export const launcher = (script: string, platform: NodeJS.Platform = process.platform): [string, string[]] =>
  platform === "win32" ? ["cmd.exe", ["/d", "/s", "/c", "call", "./scripts/launch.cmd", script]] : ["./scripts/launch", [script]];

// Start the installed copy the way Codex will (its launcher, its folder) and ask it for its tools and its page.
export function selfTest(dir: string, timeoutMs = 20_000): Promise<{ ok: boolean; tools: string[]; error: string | null }> {
  return new Promise((done) => {
    const scratch = mkdtempSync(join(tmpdir(), "cam-selftest-"));
    const [command, args] = launcher("./src/plugin-server.ts");
    const child = spawn(command, args, {
      cwd: dir, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, CAM_NO_ENGINE: "1", CAM_DATA_DIR: scratch },
    });
    const replies = new Map<number, Json>();
    let buffer = "";
    let errors = "";
    const finish = (result: { ok: boolean; tools: string[]; error: string | null }) => {
      clearTimeout(timer);
      child.stdin.end();
      done(result);
    };
    const timer = setTimeout(() => finish({ ok: false, tools: [], error: `没有在 ${timeoutMs / 1000} 秒内响应。${errors.trim()}` }), timeoutMs);
    child.stderr.on("data", (chunk: Buffer) => { errors += chunk.toString("utf8"); });
    child.on("error", (error) => finish({ ok: false, tools: [], error: String(error) }));
    child.stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
        const line = buffer.slice(0, end).trim();
        buffer = buffer.slice(end + 1);
        if (!line) continue;
        try { const message = JSON.parse(line); if (typeof message.id === "number") replies.set(message.id, message); } catch { /* not ours */ }
      }
      if (replies.has(3)) {
        const tools = (replies.get(2)?.result?.tools ?? []).map((tool: Json) => tool.name);
        const page = replies.get(3)?.result?.contents?.[0]?.text ?? "";
        finish(tools.includes("cam_panel") && page.includes("<title>") ? { ok: true, tools, error: null } : { ok: false, tools, error: "工具或面板页面不完整" });
      }
    });
    const send = (message: Json) => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
    send({ id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "cam-install-selftest" } } });
    send({ method: "notifications/initialized" });
    send({ id: 2, method: "tools/list" });
    send({ id: 3, method: "resources/read", params: { uri: "ui://codex-attachment-manager/panel.html" } });
  });
}

// Selections made before P5 lived in the repository's local/ folder; they move along once, never overwriting.
function migrateSelections(): number {
  const legacy = join(repository, "local", "selection");
  const target = selectionDirOf();
  if (!existsSync(legacy) || resolve(legacy) === resolve(target)) return 0;
  mkdirSync(target, { recursive: true });
  let moved = 0;
  for (const name of readdirSync(legacy).filter((file) => file.endsWith(".json"))) {
    if (existsSync(join(target, name))) continue;
    copyFileSync(join(legacy, name), join(target, name));
    moved++;
  }
  return moved;
}

async function main(): Promise<void> {
  const [command, threadId, ...ids] = process.argv.slice(2);
  // The same port the plugin's MCP server uses: --port, else CAM_ENGINE_PORT, else the default.
  const port = Number(process.argv.includes("--port") ? process.argv[process.argv.indexOf("--port") + 1] : process.env.CAM_ENGINE_PORT ?? DEFAULT_PORT);

  if (command === "install") {
    if (!existsSync(join(repository, ".agents", "plugins", "marketplace.json"))) throw new Error("请在仓库里运行：node plugin/src/cam.ts install");
    const cli = findCodexCli();
    if (!cli) throw new Error("找不到 Codex 的命令行。请先安装 Codex 桌面版并至少打开过一次，或者安装 Codex 命令行；也可以用环境变量 CODEX_CLI_PATH 指定它的位置。");
    // A conflict with the user's own settings stops everything before anything changes.
    planInstall({ configText: readConfig(), envText: readEnv(), env: userProxyEnv(), port });
    backupConfig();
    const steps: string[] = [];
    const registered = pluginStatus(readConfig()).marketplace;
    if (registered && !samePath(registered, repository)) { codex(cli, ["plugin", "marketplace", "remove", MARKETPLACE]); steps.push("去掉指向别处的旧插件市场"); }
    if (!registered || !samePath(registered, repository)) { codex(cli, ["plugin", "marketplace", "add", repository]); steps.push("登记插件市场（这个仓库）"); }
    // Installed afresh every time, so Codex's copy matches this checkout.
    if (pluginStatus(readConfig()).installed) { codex(cli, ["plugin", "remove", PLUGIN_ID]); steps.push("卸掉旧的插件副本"); }
    codex(cli, ["plugin", "add", PLUGIN_ID]);
    steps.push("安装插件");
    const installed = pluginCacheDir(pluginVersion());
    const test = await selfTest(installed);
    if (!test.ok) throw new Error(`装好的插件服务没能启动：${test.error}。代理设置没有写入，Codex 仍然直连。`);
    steps.push(`自检通过：插件服务能启动，提供 ${test.tools.join("、")}`);
    const plan = useEngine(port);
    const migrated = migrateSelections();
    // The installed copy runs the engine, as it will when Codex starts it; an older engine still running is replaced.
    const engine = await ensureEngine({ port, dir: join(installed, "src") });
    console.log(JSON.stringify({ command, steps, configChanged: plan.configChanged, envChanged: plan.envChanged, notes: plan.notes, migratedSelections: migrated, dataDir: dataDir(), engine: engine.state, enginePid: engine.health?.pid ?? null, next: "重启 Codex 后生效。面板在任务右侧的侧边面板：新建标签页 → 插件和 MCP → 上下文素材" }, null, 2));
    return;
  }
  if (command === "setup") {
    // Only once Codex has the plugin: otherwise nothing would start the engine after Codex restarts.
    if (!pluginStatus(readConfig()).installed || !existsSync(pluginCacheDir(pluginVersion()))) throw new Error("插件还没有装进 Codex：请先安装插件，再运行 setup。");
    const plan = useEngine(port);
    // Started from this copy, which is the installed one when the install scripts run it.
    const engine = await ensureEngine({ port });
    console.log(JSON.stringify({ command, configChanged: plan.configChanged, envChanged: plan.envChanged, notes: plan.notes, dataDir: dataDir(), engine: engine.state, enginePid: engine.health?.pid ?? null, next: "重启 Codex 后生效。面板在任务右侧的侧边面板：新建标签页 → 插件和 MCP → 上下文素材" }, null, 2));
    return;
  }
  if (command === "uninstall") {
    // Codex goes back to connecting directly first; only then is the plugin that starts the engine removed.
    const plan = connectDirectly();
    const steps = ["恢复直连：去掉代理设置" + (plan.envChanged ? "和 .env 里的 NO_PROXY" : "")];
    const cli = findCodexCli();
    const status = pluginStatus(readConfig());
    if (!cli && (status.installed || status.marketplace)) steps.push("找不到 Codex 的命令行，插件没有卸载；可以在 Codex 的插件页面里移除");
    if (cli && status.installed) { codex(cli, ["plugin", "remove", PLUGIN_ID]); steps.push("卸载插件"); }
    if (cli && status.marketplace) { codex(cli, ["plugin", "marketplace", "remove", MARKETPLACE]); steps.push("去掉插件市场"); }
    console.log(JSON.stringify({ command, steps, configChanged: plan.configChanged, envChanged: plan.envChanged, dataDir: dataDir(), next: "重启 Codex 后生效；引擎会在 Codex 全部退出后自己退出。勾选记录留在数据目录里，不需要可以删掉" }, null, 2));
    return;
  }
  if (command === "status") {
    const config = readConfig();
    const health = await engineHealth(port);
    const version = pluginVersion();
    console.log(JSON.stringify({
      command,
      proxy: proxyStatus(config),
      plugin: { ...pluginStatus(config), version, cached: existsSync(pluginCacheDir(version)) },
      legacyMcpServer: config.split(/\r?\n/).some((line) => line.trim() === MCP_BEGIN),
      dotenv: noProxyStatus(readEnv() ?? ""),
      engine: health ? { running: true, pid: health.pid, startedAt: health.startedAt, version: health.version ?? null, build: health.build ?? null, sameAsInstalled: health.build === buildOf(join(pluginCacheDir(version), "src")) } : { running: false },
      codexCli: findCodexCli(),
      dataDir: dataDir(),
    }, null, 2));
    return;
  }
  if (!command || !threadId) throw new Error("usage: cam.ts install [--port N] | setup [--port N] | uninstall | status | list|uncheck|check|check-all <thread id> [IMG-…]");
  const options = { sessionsDir: join(codexHome(), "sessions") };
  if (command === "list") console.log(table(loadPanelState(threadId, options)));
  else if (command === "uncheck") console.log(table(applySelection(threadId, { uncheck: ids }, options)));
  else if (command === "check") console.log(table(applySelection(threadId, { check: ids }, options)));
  else if (command === "check-all") console.log(table(applySelection(threadId, { checkAll: true }, options)));
  else throw new Error(`unknown command ${command}`);
}

if (isEntryPoint(import.meta.url)) await main();
