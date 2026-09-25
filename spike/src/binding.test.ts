// Purpose: v0.1-10 — a panel opened on a new chat: which threads count as "the user just started one" (not sub-agents,
// internal tasks, forks, exec or automation threads; only those started while the panel page was on screen), and the
// binding that makes the panel's later calls about the new thread.
// Input: synthetic rollouts in today's folder of temporary sessions directories; output: Node test assertions only.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { bindThread, boundThread, isUserThread, newThreads, resolveThread, type Shown } from "../../plugin/src/binding.ts";
import { startThread } from "./testfixtures.ts";

const PANEL = "01a0d301-0000-7000-8000-00000000f00d";
const USER = "01a0d301-0000-7000-8000-0000000000c1";
const SUB = "01a0d301-0000-7000-8000-0000000000c2";
const FORK = "01a0d301-0000-7000-8000-0000000000c3";
const ELSEWHERE = "01a0d301-0000-7000-8000-0000000000c4";
const AUTO = "01a0d301-0000-7000-8000-0000000000c5";

function dirs() {
  const root = mkdtempSync(join(tmpdir(), "cam-binding-"));
  mkdirSync(join(root, "sessions"));
  return { sessionsDir: join(root, "sessions"), bindings: join(root, "data", "bindings") };
}

test("only threads the user started in a chat count", () => {
  assert.equal(isUserThread({ source: "vscode", thread_source: "user" }), true);
  assert.equal(isUserThread({ source: "cli" }), true, "older rollouts have no thread_source");
  assert.equal(isUserThread({ source: { custom: "desktop" } }), true);
  assert.equal(isUserThread({ source: { subagent: { thread_spawn: { parent_thread_id: USER, depth: 1 } } }, thread_source: "subagent", parent_thread_id: USER }), false);
  assert.equal(isUserThread({ source: { subagent: "review" } }), false);
  assert.equal(isUserThread({ source: { internal: "memory_consolidation" } }), false);
  assert.equal(isUserThread({ source: "vscode", thread_source: "user", forked_from_id: USER }), false, "a fork");
  assert.equal(isUserThread({ source: "exec" }), false);
  assert.equal(isUserThread({ source: "mcp" }), false);
  assert.equal(isUserThread({ source: "vscode", thread_source: "pull_request_fix_automation" }), false, "a feature's thread");
  assert.equal(isUserThread(null), false);
});

test("only user threads started while the panel was on screen are offered, however late the panel asks", () => {
  const { sessionsDir } = dirs();
  const now = Date.now();
  startThread(sessionsDir, USER, {}, 40_000);
  startThread(sessionsDir, SUB, { source: { subagent: { thread_spawn: { parent_thread_id: USER, depth: 1 } } }, thread_source: "subagent", parent_thread_id: USER, forked_from_id: USER }, 38_000);
  startThread(sessionsDir, FORK, { forked_from_id: USER }, 39_000);
  startThread(sessionsDir, AUTO, { thread_source: "heartbeat_automation" }, 39_000);
  startThread(sessionsDir, ELSEWHERE, {}, 20_000);
  // On screen until 42 s ago (the user sent 2 s after the page last noted itself, then left), and again for 5 s.
  const shown: Shown = [[now - 60_000, now - 42_000], [now - 5_000, now]];
  assert.deepEqual(newThreads(sessionsDir, shown).map((entry) => entry.threadId), [USER], "the one started while the page was hidden is not this page's");
  assert.deepEqual(newThreads(sessionsDir, [[now - 60_000, now - 50_000]]), [], "hidden for 10 s by then");
  assert.deepEqual(newThreads(sessionsDir, []), []);
  assert.deepEqual(newThreads(sessionsDir, "not a list"), []);
  const [only] = newThreads(sessionsDir, shown);
  assert.ok(Math.abs(only.startedAt - (now - 40_000)) < 1_000, "started when its first line was written");
});

test("a panel's calls follow its binding until its own thread has a rollout", () => {
  const { sessionsDir, bindings } = dirs();
  startThread(sessionsDir, USER);
  assert.equal(resolveThread(PANEL, sessionsDir, bindings), PANEL, "not bound yet");
  assert.equal(boundThread(PANEL, bindings), null);
  bindThread(PANEL, USER, bindings);
  assert.equal(resolveThread(PANEL, sessionsDir, bindings), USER);
  assert.equal(resolveThread(USER, sessionsDir, bindings), USER, "a thread with a rollout is itself");
  assert.equal(resolveThread("chatgpt:abc", sessionsDir, bindings), "chatgpt:abc");
  startThread(sessionsDir, PANEL);
  assert.equal(resolveThread(PANEL, sessionsDir, bindings), PANEL, "its own rollout wins");
  assert.throws(() => bindThread(PANEL, "../x", bindings), /not a thread id/);
});

test("of the tasks started while the panel was on screen, the newest is offered; two started at once are both offered", () => {
  const { sessionsDir } = dirs();
  const now = Date.now();
  const shown: Shown = [[now - 120_000, now]];
  startThread(sessionsDir, USER, {}, 60_000);
  startThread(sessionsDir, FORK.replace("c3", "d3"), {}, 5_000);
  assert.deepEqual(newThreads(sessionsDir, shown).map((entry) => entry.threadId), [FORK.replace("c3", "d3")], "the later task wins; the panel does not ask again every few minutes");
  startThread(sessionsDir, AUTO.replace("c5", "d5"), {}, 1_000);
  assert.deepEqual(newThreads(sessionsDir, shown).map((entry) => entry.threadId), [FORK.replace("c3", "d3"), AUTO.replace("c5", "d5")], "started within 20 s of each other: the user picks");
});

test("binding records older than a week are dropped when a new one is written", () => {
  const { sessionsDir, bindings } = dirs();
  startThread(sessionsDir, USER);
  mkdirSync(bindings, { recursive: true });
  const stale = join(bindings, "01a0d301-0000-7000-8000-00000000aaaa.json");
  const recent = join(bindings, "01a0d301-0000-7000-8000-00000000bbbb.json");
  for (const file of [stale, recent]) writeFileSync(file, JSON.stringify({ threadId: USER, at: "2026-09-01T00:00:00Z" }));
  const eightDaysAgo = new Date(Date.now() - 8 * 86_400_000);
  utimesSync(stale, eightDaysAgo, eightDaysAgo);
  bindThread(PANEL, USER, bindings);
  assert.deepEqual([existsSync(stale), existsSync(recent), existsSync(join(bindings, `${PANEL}.json`))], [false, true, true]);
});
