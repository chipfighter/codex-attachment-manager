// Purpose: P3-2 — engine lifecycle: health identity, Codex process detection, auto-exit after consecutive misses,
// one instance per port (a real engine is started on a spare port with its data in a temporary folder), and the
// per-thread request statistics. v0.1-3 — builds, and a newer engine taking over from an older one.
// Input: synthetic tasklist and ps output and a temporary data folder; output: Node test assertions only.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { appendFileSync, cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { buildOf, compareVersions, countClaudeInPs, countClaudeProcesses, countCodexInPs, countCodexProcesses, engineHealth, ensureEngine, isEngineHealth, shouldReplace, watchForCodex, type Health } from "../../plugin/src/engine.ts";
import { selectionDirOf } from "../../plugin/src/paths.ts";
import { readRequestStats, recordRequest } from "../../plugin/src/request-stats.ts";
import { writeSelection } from "../../plugin/src/selection.ts";

const here = dirname(fileURLToPath(import.meta.url));
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

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

test("an engine's build follows its code, not its line endings; a missing folder has none", () => {
  const [lf, crlf] = [mkdtempSync(join(tmpdir(), "cam-build-")), mkdtempSync(join(tmpdir(), "cam-build-"))];
  writeFileSync(join(lf, "x.ts"), "const a = 1;\nconst b = 2;\n");
  writeFileSync(join(crlf, "x.ts"), "const a = 1;\r\nconst b = 2;\r\n");
  assert.equal(buildOf(lf), buildOf(crlf));
  writeFileSync(join(crlf, "x.ts"), "const a = 1;\nconst b = 3;\n");
  assert.notEqual(buildOf(lf), buildOf(crlf));
  assert.equal(buildOf(join(lf, "gone")), null);
});

test("Claude Code processes count too (v0.4): claude.exe on Windows, claude or Claude elsewhere", () => {
  const rows = '"claude.exe","100","Console","1","9,000 K"\r\n"Claude.exe","101","Console","1","9,000 K"\r\n"codex.exe","102","Console","1","9,000 K"\r\n';
  assert.equal(countClaudeProcesses(rows), 2);
  assert.equal(countCodexProcesses(rows), 1);
  assert.equal(countClaudeInPs("/Applications/Claude.app/Contents/MacOS/Claude\n/Users/x/.local/bin/claude\nclaude-helper\nnode\n"), 2);
});

test("only different code of a newer version replaces a running engine; the same version only when installing", () => {
  const running = (build?: string, version?: string): Health => ({ ok: true, service: "codex-attachment-manager", pid: 1, startedAt: "", port: 1, build, version });
  assert.equal(shouldReplace(running("aaa", "0.1.0"), { build: "aaa", version: "0.1.0" }), false);
  assert.equal(shouldReplace(running("aaa", "0.1.0"), { build: "bbb", version: "0.1.0" }), false, "v0.4: Codex's and Claude's copies differ until both are updated; the running engine stays");
  assert.equal(shouldReplace(running("aaa", "0.1.0"), { build: "bbb", version: "0.1.0" }, true), true, "the same version installed again (cam install)");
  assert.equal(shouldReplace(running("aaa", "0.1.0"), { build: "aaa", version: "0.1.0" }, true), false, "the same code is never replaced");
  assert.equal(shouldReplace(running("aaa", "0.1.0"), { build: "bbb", version: "0.2.0" }), true);
  assert.equal(shouldReplace(running("aaa", "0.2.0"), { build: "bbb", version: "0.1.0" }), false, "an older plugin still running never pushes a newer engine out");
  assert.equal(shouldReplace(running("aaa", "0.1.0"), { build: null, version: "0.1.0" }), false, "a plugin whose folder is gone");
  assert.equal(shouldReplace(running(), { build: "bbb", version: "0.1.0" }), true, "an engine from before v0.1-3");
  assert.ok(compareVersions("0.10.0", "0.9.1") > 0);
  assert.equal(compareVersions("1.2.3-beta.1", "1.2.3"), 0);
});

test("a newer engine takes over the port at once; the old one exits after the request it was serving", async (t) => {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const data = mkdtempSync(join(tmpdir(), "cam-handoff-"));
  process.env.CAM_DATA_DIR = data;
  t.after(() => { delete process.env.CAM_DATA_DIR; });
  // A thread with an unchecked image: its request waits for the whole body before anything goes upstream.
  const thread = "01a0d301-0000-7000-8000-00000000000d";
  writeSelection({ threadId: thread, unchecked: { "msg_1#0": { id: "IMG-001", at: "2026-09-25T00:00:00Z" } } }, selectionDirOf(data));
  // Two installed copies of the plugin that differ by one comment.
  const copy = (extra: string) => {
    const root = mkdtempSync(join(tmpdir(), "cam-plugin-"));
    for (const part of ["src", ".codex-plugin"]) cpSync(join(here, "..", "..", "plugin", part), join(root, part), { recursive: true });
    appendFileSync(join(root, "src", "engine.ts"), extra);
    return join(root, "src");
  };
  const [older, newer] = [copy(""), copy("\n// a newer build\n")];
  const first = await ensureEngine({ port, dir: older, extraArgs: ["--stay"] });
  assert.equal(first.state, "started");
  const oldPid = first.health!.pid;
  t.after(() => { try { process.kill(oldPid); } catch { /* already gone */ } });
  assert.equal(first.health!.build, buildOf(older));

  const pending = net.connect(port, "127.0.0.1");
  await once(pending, "connect");
  pending.write(`POST /backend-api/codex/responses HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: 1000\r\nx-codex-turn-metadata: {"thread_id":"${thread}"}\r\n\r\n{"model":`);
  await sleep(300);

  // v0.4: the same version with other code waits for an install; the install replaces it.
  assert.deepEqual([(await ensureEngine({ port, dir: newer, extraArgs: ["--stay"] })).state, (await engineHealth(port))?.pid], ["running", oldPid]);
  const next = await ensureEngine({ port, dir: newer, extraArgs: ["--stay"], force: true });
  t.after(() => { try { process.kill(next.health!.pid); } catch { /* already gone */ } });
  assert.deepEqual([next.state, next.replaced?.pid, next.health?.build], ["replaced", oldPid, buildOf(newer)]);
  assert.equal((await engineHealth(port))?.pid, next.health!.pid, "new connections reach the new engine");
  assert.equal(alive(oldPid), true, "the old engine keeps serving the request under way");
  pending.destroy();
  for (let i = 0; i < 50 && alive(oldPid); i++) await sleep(100);
  assert.equal(alive(oldPid), false, "and exits once it is done");
  assert.equal((await ensureEngine({ port, dir: newer })).state, "running", "the same code again leaves it alone");
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
