// Purpose: the tool's command line. P3-4: install / uninstall / status set up and remove every managed setting at
// once; list / uncheck / check / check-all stand in for the panel until P4.
// Input: install [--port N] | uninstall | status | list|uncheck|check|check-all <thread id> [IMG-…].
// Output: config.toml (copied to <data dir>/config-backup/ before every change), ~/.codex/.env (never copied or
// printed: it may hold credentials), the selection file, and a summary on stdout. Rollouts are only read.

import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { codexHome, MCP_BEGIN, noProxyStatus, persistedEnv, proxyStatus } from "./codexconfig.ts";
import { DEFAULT_PORT, engineHealth, ensureEngine } from "./engine.ts";
import { planInstall, planUninstall, type Plan } from "./install.ts";
import { applySelection, loadPanelState, type PanelState } from "./panel-state.ts";
import { dataDir } from "./paths.ts";

const KIND: Record<string, string> = { upload: "上传", view: "工具查看", generated: "生成", tool: "工具结果" };

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

function applyPlan(plan: Plan, configFile: string, envFile: string): void {
  if (plan.configChanged) {
    const backups = join(dataDir(), "config-backup");
    mkdirSync(backups, { recursive: true });
    if (existsSync(configFile)) copyFileSync(configFile, join(backups, `config.toml.${new Date().toISOString().replaceAll(":", "-")}`));
    writeFileSync(configFile, plan.configText, "utf8");
  }
  if (plan.envChanged) {
    if (plan.envText === null) rmSync(envFile, { force: true });
    else {
      writeFileSync(`${envFile}.cam-tmp`, plan.envText, "utf8");
      renameSync(`${envFile}.cam-tmp`, envFile);
    }
  }
}

async function main(): Promise<void> {
  const [command, threadId, ...ids] = process.argv.slice(2);
  const configFile = join(codexHome(), "config.toml");
  const envFile = join(codexHome(), ".env");
  const readConfig = () => (existsSync(configFile) ? readFileSync(configFile, "utf8") : "");
  const readEnv = () => (existsSync(envFile) ? readFileSync(envFile, "utf8") : null);
  const port = Number(process.argv.includes("--port") ? process.argv[process.argv.indexOf("--port") + 1] : DEFAULT_PORT);

  if (command === "install") {
    const env = { httpProxy: persistedEnv("HTTPS_PROXY") ?? persistedEnv("HTTP_PROXY") ?? persistedEnv("ALL_PROXY"), noProxy: persistedEnv("NO_PROXY") };
    const plan = planInstall({ configText: readConfig(), envText: readEnv(), env, port, nodePath: process.execPath, serverScript: resolve(import.meta.dirname, "plugin-server.ts") });
    applyPlan(plan, configFile, envFile);
    const engine = await ensureEngine({ port });
    console.log(JSON.stringify({ command, configChanged: plan.configChanged, envChanged: plan.envChanged, notes: plan.notes, engine: engine.state, enginePid: engine.health?.pid ?? null, next: "重启 Codex 后生效" }, null, 2));
    return;
  }
  if (command === "uninstall") {
    const plan = planUninstall({ configText: readConfig(), envText: readEnv() });
    applyPlan(plan, configFile, envFile);
    console.log(JSON.stringify({ command, configChanged: plan.configChanged, envChanged: plan.envChanged, next: "重启 Codex 后生效；引擎会在 Codex 全部退出后自己退出" }, null, 2));
    return;
  }
  if (command === "status") {
    const config = readConfig();
    const health = await engineHealth(port);
    console.log(JSON.stringify({ command, proxy: proxyStatus(config), mcpServer: config.split(/\r?\n/).some((line) => line.trim() === MCP_BEGIN), dotenv: noProxyStatus(readEnv() ?? ""), engine: health ? { running: true, pid: health.pid, startedAt: health.startedAt } : { running: false }, dataDir: dataDir() }, null, 2));
    return;
  }
  if (!command || !threadId) throw new Error("usage: cam.ts install [--port N] | uninstall | status | list|uncheck|check|check-all <thread id> [IMG-…]");
  const options = { sessionsDir: join(codexHome(), "sessions") };
  if (command === "list") console.log(table(loadPanelState(threadId, options)));
  else if (command === "uncheck") console.log(table(applySelection(threadId, { uncheck: ids }, options)));
  else if (command === "check") console.log(table(applySelection(threadId, { check: ids }, options)));
  else if (command === "check-all") console.log(table(applySelection(threadId, { checkAll: true }, options)));
  else throw new Error(`unknown command ${command}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
