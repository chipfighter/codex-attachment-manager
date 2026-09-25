// Purpose: P3-2 — engine lifecycle: health identity, Codex process detection, auto-exit after consecutive misses,
// one instance per port (a real engine is started on a spare port with its data in a temporary folder), and the
// per-thread request statistics.
// Input: synthetic tasklist and ps output and a temporary data folder; output: Node test assertions only.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { countCodexInPs, countCodexProcesses, engineHealth, ensureEngine, isEngineHealth, watchForCodex } from "../../plugin/src/engine.ts";
import { readRequestStats, recordRequest } from "../../plugin/src/request-stats.ts";

const here = dirname(fileURLToPath(import.meta.url));

test("only our own engine counts as healthy", () => {
  assert.equal(isEngineHealth({ ok: true, service: "codex-attachment-manager", pid: 1 }), true);
  assert.equal(isEngineHealth({ ok: true, service: "something-else", pid: 1 }), false);
  assert.equal(isEngineHealth({ ok: true }), false);
  assert.equal(isEngineHealth(null), false);
});

test("Codex processes are counted from tasklist CSV, in any Windows language", () => {
  const two = '"codex.exe","23984","Console","1","123,456 K"\r\n"codex.exe","11111","Console","1","9,000 K"\r\n';
  assert.equal(countCodexProcesses(two), 2);
  assert.equal(countCodexProcesses("INFO: No tasks are running which match the specified criteria.\r\n"), 0);
  assert.equal(countCodexProcesses("信息: 没有运行的任务匹配指定标准。\r\n"), 0);
  assert.equal(countCodexProcesses('"ChatGPT.exe","23816","Console","1","200,000 K"\r\n'), 0);
});

test("on macOS and Linux, Codex processes are counted from ps by executable name", () => {
  const mac = "/sbin/launchd\n/Applications/ChatGPT.app/Contents/MacOS/ChatGPT\n/Applications/ChatGPT.app/Contents/Resources/codex\n/Applications/ChatGPT.app/Contents/Frameworks/ChatGPT Helper.app/Contents/MacOS/ChatGPT Helper\n";
  assert.equal(countCodexInPs(mac), 1);
  assert.equal(countCodexInPs("systemd\nbash\ncodex\nnode\ncodex\ncodex-code-mode-host\n"), 2);
  assert.equal(countCodexInPs("systemd\nbash\nnode\n"), 0);
});

test("the engine gives up only after consecutive checks without Codex", async () => {
  const run = (counts: number[]) => new Promise<number>((resolve) => {
    let calls = 0;
    const stop = watchForCodex(() => resolve(calls), { intervalMs: 5, misses: 2, count: async () => counts[Math.min(calls++, counts.length - 1)] });
    setTimeout(() => { stop(); resolve(-1); }, 500);
  });
  assert.equal(await run([1, 0, 0]), 3);
  assert.equal(await run([0, 1, 0, 1, 0, 0]), 6, "a Codex restart in between resets the count");
  assert.equal(await run([1]), -1, "never exits while Codex runs");
});

test("ensure starts one engine; a second start on the same port leaves it alone", async (t) => {
  const port = 20000 + Math.floor(Math.random() * 20000);
  process.env.CAM_DATA_DIR = mkdtempSync(join(tmpdir(), "cam-engine-"));
  t.after(() => { delete process.env.CAM_DATA_DIR; });
  const first = await ensureEngine({ port, extraArgs: ["--stay"] });
  assert.equal(first.state, "started");
  t.after(() => { try { process.kill(first.health!.pid); } catch { /* already gone */ } });
  const again = await ensureEngine({ port });
  assert.deepEqual([again.state, again.health?.pid], ["running", first.health!.pid]);
  const second = await new Promise<string>((resolve) => execFile(process.execPath, [join(here, "..", "..", "plugin", "src", "proxy.ts"), "--port", String(port), "--stay"], (_error, stdout) => resolve(stdout)));
  assert.match(second, /"alreadyRunning":true/);
  assert.equal((await engineHealth(port))?.pid, first.health!.pid);
});

test("request statistics are written per thread, and only for real thread ids", () => {
  const dir = mkdtempSync(join(tmpdir(), "cam-stats-"));
  const thread = "01a0d301-0000-7000-8000-000000000001";
  recordRequest(thread, { at: "2026-09-24T12:00:00Z", transport: "http", images: 3 }, dir);
  assert.equal(JSON.parse(readFileSync(join(dir, `${thread}.json`), "utf8")).latest.images, 3);
  recordRequest("../escape", { images: 1 }, dir);
  recordRequest(null, { images: 1 }, dir);
  assert.equal(existsSync(join(dir, "..", "escape.json")), false);
});

test("a WebSocket event becomes the latest without erasing the last full HTTP request", () => {
  const dir = mkdtempSync(join(tmpdir(), "cam-stats-"));
  const thread = "01a0d301-0000-7000-8000-000000000002";
  recordRequest(thread, { at: "t1", transport: "http", decodedBytes: 100 }, dir);
  recordRequest(thread, { at: "t2", transport: "websocket", event: "open" }, dir);
  assert.deepEqual(readRequestStats(thread, dir), { latest: { at: "t2", transport: "websocket", event: "open" }, lastHttp: { at: "t1", transport: "http", decodedBytes: 100 } });
  recordRequest(thread, { at: "t3", transport: "http", decodedBytes: 50 }, dir);
  assert.equal(readRequestStats(thread, dir)!.lastHttp!.decodedBytes, 50);
});
