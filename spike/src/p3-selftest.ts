// Purpose: P3-5 — stability of the core with our own app-server in the desktop's environment, configured exactly as an
// install would (openai_base_url, respect_system_proxy, the plugin's MCP server) but through -c overrides, so the
// user's config.toml is untouched. Scenarios: the plugin server starts the engine; two threads with different
// selections; the engine crashes and comes back; compaction of a thread with an unchecked image; a forked thread.
// Input: [--label name]. Output: local/p3/selftest-<label>.json (synthetic test threads only).

import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { AppServer, findBundledCodex } from "./appserver.ts";
import { codexHome } from "../../plugin/src/codexconfig.ts";
import { DEFAULT_PORT, engineHealth } from "../../plugin/src/engine.ts";
import { SERVER_NAME } from "../../plugin/src/install.ts";
import { applySelection } from "../../plugin/src/panel-state.ts";
import { dataDir, proxyLogDirOf, requestStatsDirOf } from "../../plugin/src/paths.ts";
import { runTurn, TEST_MODEL, testImages, text } from "./testkit.ts";

type Json = Record<string, any>;
const here = dirname(fileURLToPath(import.meta.url));

async function waitFor<T>(probe: () => Promise<T | null>, timeoutMs: number): Promise<{ value: T | null; ms: number }> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = await probe();
    if (value) return { value, ms: Date.now() - started };
    await sleep(250);
  }
  return { value: null, ms: Date.now() - started };
}

function proxyEntries(since: string, threadIds: string[]): Json[] {
  const file = join(proxyLogDirOf(), `${new Date().toISOString().slice(0, 10)}.jsonl`);
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line)).filter((entry) => entry.at >= since && threadIds.includes(entry.threadId));
}

const shortEntry = (entry: Json) => ({
  at: entry.at.slice(11, 19), thread: String(entry.threadId).slice(-4), transport: entry.transport,
  what: entry.declined ? `426` : entry.transport === "websocket" ? `ws ${entry.upstreamStatus ?? ""}`.trim() : `${entry.method} ${String(entry.path).split("/").pop()} ${entry.status}`,
  replaced: entry.rewrite?.replaced?.map((r: Json) => `${r.id}:${r.mode}`) ?? null, skipped: entry.rewrite?.skipped ?? null, error: entry.error ?? null,
});

async function main(): Promise<void> {
  const label = process.argv.includes("--label") ? process.argv[process.argv.indexOf("--label") + 1] : "default";
  const workDir = join(dataDir(), "p3", "work");
  mkdirSync(workDir, { recursive: true });
  const file = (name: string) => join(workDir, name);
  writeFileSync(file("a.png"), testImages.redSquare());
  writeFileSync(file("b.png"), testImages.blueCircle());
  writeFileSync(file("c.png"), testImages.whiteTriangle());
  const result: Json = { label, checks: {} };

  // Scenario A needs the engine down, so the plugin server has to start it.
  const before = await engineHealth();
  if (before) { process.kill(before.pid); await waitFor(async () => ((await engineHealth()) ? null : true), 5000); }
  result.engineBefore = before ? `killed ${before.pid}` : "not running";

  const startedAt = new Date().toISOString();
  const server = new AppServer(findBundledCodex(), [
    "-c", `openai_base_url="http://localhost:${DEFAULT_PORT}/backend-api/codex"`,
    "-c", "features.respect_system_proxy=true",
    "-c", `mcp_servers.${SERVER_NAME}.command=${JSON.stringify(process.execPath)}`,
    "-c", `mcp_servers.${SERVER_NAME}.args=${JSON.stringify([join(here, "..", "..", "plugin", "src", "plugin-server.ts")])}`,
    "-c", `mcp_servers.${SERVER_NAME}.default_tools_approval_mode="approve"`,
  ], { NO_PROXY: undefined, no_proxy: undefined }, join(dataDir(), "logs", `p3-selftest-${label}-${startedAt.replaceAll(":", "-")}.log`));
  const threads: Json = {};
  try {
    await server.initialize();
    const start = async (name: string) => {
      const { thread } = await server.request<{ thread: Json }>("thread/start", { model: TEST_MODEL, cwd: workDir, approvalPolicy: "never", sandbox: "read-only", ephemeral: false });
      await server.request("thread/name/set", { threadId: thread.id, name: `[CAM测试] P3 稳定性 ${label} ${name}` });
      threads[name] = thread.id;
      return thread.id as string;
    };

    // A — the plugin server (started by Codex with the thread) brings the engine up.
    const t1 = await start("T1");
    const engineUp = await waitFor(() => engineHealth(), 20_000);
    result.checks.pluginServerStartsEngine = !!engineUp.value;
    result.engineStartMs = engineUp.ms;
    const firstPid = engineUp.value?.pid ?? null;

    // B — two threads; only T1 unchecks an image.
    const t2 = await start("T2");
    const ok = (turn: Json) => turn.status === "completed" && !turn.errors.length;
    const turns: Json = {};
    turns.t1Upload = await runTurn(server, t1, [text("这是两张测试图，先不用描述，只回复“收到”。"), { type: "localImage", path: file("a.png") }, { type: "localImage", path: file("b.png") }]);
    turns.t2Upload = await runTurn(server, t2, [text("这是一张测试图，先不用描述，只回复“收到”。"), { type: "localImage", path: file("c.png") }]);
    applySelection(t1, { uncheck: ["IMG-001"] }, { sessionsDir: join(codexHome(), "sessions") });
    await sleep(2500);
    turns.t1AfterUncheck = await runTurn(server, t1, [text("请只回复“好的”。")]);
    turns.t2Normal = await runTurn(server, t2, [text("请只回复“好的”。")]);

    // C — the engine dies; the plugin server's watchdog brings it back.
    if (firstPid) process.kill(firstPid);
    const back = await waitFor(async () => { const health = await engineHealth(); return health && health.pid !== firstPid ? health : null; }, 30_000);
    result.checks.engineRestarted = !!back.value;
    result.engineRestartMs = back.ms;
    turns.t1AfterRestart = await runTurn(server, t1, [text("请只回复“好的”。")]);

    // D — compaction of a thread with an unchecked image, then ask about that image.
    const compactFrom = new Date().toISOString();
    const known = new Set(Object.values(turns).map((t: Json) => t.turnId));
    const before = server.notifications.length;
    await server.request("thread/compact/start", { threadId: t1 });
    // Compaction runs as its own turn: find that turn, then wait for it to finish before the next turn.
    const isNew = (n: { params: Json }) => server.notifications.indexOf(n as any) >= before && n.params?.threadId === t1 && !known.has(n.params.turn?.id);
    const compactTurn = await server.waitFor((n) => n.method === "turn/started" && isNew(n), 60_000).then((n) => n.params.turn.id as string, () => null);
    const compacted = compactTurn ? await server.waitFor((n) => n.method === "turn/completed" && n.params.turn?.id === compactTurn, 5 * 60_000).then((n) => n.params.turn.status, () => "timeout") : "no compaction turn";
    result.compactionFinished = compacted;
    result.compactionRequests = proxyEntries(compactFrom, [t1]).map(shortEntry);
    turns.t1AfterCompaction = await runTurn(server, t1, [text("第一张图 a.png 是什么颜色、什么形状？不要调用任何工具。")]);

    // F — a fork gets its own selection.
    const { thread: fork } = await server.request<{ thread: Json }>("thread/fork", { threadId: t1 });
    threads.T1fork = fork.id;
    turns.forkTurn = await runTurn(server, fork.id, [text("请只回复“好的”。")]);

    result.turns = Object.fromEntries(Object.entries(turns).map(([name, turn]: [string, Json]) => [name, { status: turn.status, errors: turn.errors, reply: String(turn.reply).slice(0, 120) }]));
    result.checks.allTurnsClean = Object.values(turns).every(ok);
  } finally {
    await server.stop();
  }

  const entries = proxyEntries(startedAt, Object.values(threads));
  result.proxy = entries.map(shortEntry);
  const posts = (thread: string) => entries.filter((entry) => entry.threadId === thread && entry.transport === "http" && /responses$/.test(entry.path));
  const t1Posts = posts(threads.T1);
  result.checks.t1Rewritten = t1Posts.length > 0 && t1Posts.every((entry) => entry.rewrite?.replaced?.some((r: Json) => r.id === "IMG-001"));
  const t2Entries = entries.filter((entry) => entry.threadId === threads.T2);
  result.checks.t2Untouched = t2Entries.length > 0 && t2Entries.every((entry) => !entry.rewrite && !entry.declined);
  result.checks.compactionRewritten = (result.compactionRequests as Json[]).some((entry) => entry.replaced?.includes("IMG-001:plain"));
  result.checks.stillHiddenAfterCompaction = /IMG-001|看不到|无法|没有提供/.test(result.turns?.t1AfterCompaction?.reply ?? "");
  result.forkRequests = entries.filter((entry) => entry.threadId === threads.T1fork).map(shortEntry);
  result.statsFiles = Object.fromEntries(Object.entries(threads).map(([name, id]) => [name, existsSync(join(requestStatsDirOf(), `${id}.json`))]));
  result.threads = threads;
  mkdirSync(join(dataDir(), "p3"), { recursive: true });
  writeFileSync(join(dataDir(), "p3", `selftest-${label}.json`), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
}

await main();
