// Purpose: P3-5 — how the engine's life is tied to Codex: does it survive when the plugin-server instance that started
// it is ended (Codex ends some instances right after startup), and does it end when the app-server exits?
// No model calls: starting a thread is enough for Codex to launch the plugin server.
// Input: none. Output: console summary; local/p3/lifecycle.json.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { AppServer, findBundledCodex } from "./appserver.ts";
import { engineHealth } from "../../plugin/src/engine.ts";
import { SERVER_NAME } from "../../plugin/src/install.ts";
import { dataDir } from "../../plugin/src/paths.ts";
import { TEST_MODEL } from "./testkit.ts";

type Json = Record<string, any>;
const here = dirname(fileURLToPath(import.meta.url));

async function waitFor<T>(probe: () => Promise<T | null>, timeoutMs: number): Promise<T | null> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = await probe();
    if (value) return value;
    await sleep(250);
  }
  return null;
}

async function main(): Promise<void> {
  const result: Json = {};
  const running = await engineHealth();
  if (running) { process.kill(running.pid); await sleep(1000); }
  const startedAt = new Date().toISOString();
  const server = new AppServer(findBundledCodex(), [
    "-c", `mcp_servers.${SERVER_NAME}.command=${JSON.stringify(process.execPath)}`,
    "-c", `mcp_servers.${SERVER_NAME}.args=${JSON.stringify([join(here, "..", "..", "plugin", "src", "plugin-server.ts")])}`,
  ], { NO_PROXY: undefined, no_proxy: undefined }, join(dataDir(), "logs", `p3-lifecycle-${startedAt.replaceAll(":", "-")}.log`));
  try {
    await server.initialize();
    await server.request("thread/start", { model: TEST_MODEL, cwd: dataDir(), approvalPolicy: "never", sandbox: "read-only", ephemeral: true });
    const engine = await waitFor(() => engineHealth(), 20_000);
    result.engineStarted = engine?.pid ?? null;
    const starters = readFileSync(join(dataDir(), "plugin-server.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line))
      .filter((entry) => entry.at >= startedAt && entry.event === "engine" && entry.state === "started" && entry.enginePid === engine?.pid);
    const starter = starters[0]?.pid ?? null;
    result.startedByPluginServer = starter;
    if (starter) {
      process.kill(starter);
      await sleep(2500);
      const after = await engineHealth();
      result.engineAfterStarterKilled = after ? (after.pid === engine?.pid ? "same engine still running" : `replaced by ${after.pid}`) : "gone";
    }
  } finally {
    await server.stop();
  }
  await sleep(3000);
  const afterStop = await engineHealth();
  result.engineAfterAppServerStopped = afterStop ? `still running (${afterStop.pid})` : "gone";
  const exits = readFileSync(join(dataDir(), "proxy", `${new Date().toISOString().slice(0, 10)}.jsonl`), "utf8").trim().split("\n").map((line) => JSON.parse(line))
    .filter((entry) => entry.at >= startedAt && entry.event === "engine-exit");
  result.loggedExits = exits.map((entry) => `${entry.pid}: ${entry.reason}`);
  if (afterStop) process.kill(afterStop.pid);
  mkdirSync(join(dataDir(), "p3"), { recursive: true });
  writeFileSync(join(dataDir(), "p3", "lifecycle.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
}

await main();
