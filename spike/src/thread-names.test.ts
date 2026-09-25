// Purpose: v0.1-9 — the task's name for the panel's title: Codex's session_index.jsonl read incrementally (last
// non-empty name wins, a rewritten file is read again), and the first message as the fallback.
// Input: synthetic index files and history records in temporary folders; output: Node test assertions only.

import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { firstMessage, sessionIndexOf, threadName, threadTitle } from "../../plugin/src/thread-names.ts";

const A = "01a0d301-0000-7000-8000-0000000000a1";
const B = "01a0d301-0000-7000-8000-0000000000b2";
const entry = (id: string, name: string) => `${JSON.stringify({ id, thread_name: name, updated_at: "2026-09-25T10:00:00Z" })}\n`;
const message = (text: string) => ({ type: "event_msg", payload: { type: "user_message", message: text } });

function home(): string {
  const root = mkdtempSync(join(tmpdir(), "cam-names-"));
  mkdirSync(join(root, "sessions"));
  return join(root, "sessions");
}

test("the index sits next to the sessions folder; the last non-empty name of a thread wins, renames included", () => {
  const sessions = home();
  const index = sessionIndexOf(sessions);
  assert.equal(index, join(sessions, "..", "session_index.jsonl").replace(/[\\/]sessions[\\/]\.\./, ""));
  assert.equal(threadName(sessions, A), null, "no index yet");
  writeFileSync(index, entry(A, "第一版") + entry(B, "别的任务"));
  assert.equal(threadName(sessions, A), "第一版");
  appendFileSync(index, entry(A, "  改过的名字  ") + entry(A, "   ") + "{broken\n");
  assert.equal(threadName(sessions, A), "改过的名字", "a rename appends a line; an empty name and a damaged line are skipped");
  assert.equal(threadName(sessions, B), "别的任务");
});

test("a rewritten index (Codex removing a thread's names) is read again from the start", () => {
  const sessions = home();
  const index = sessionIndexOf(sessions);
  writeFileSync(index, entry(A, "要删掉的名字") + entry(B, "留下的名字"));
  assert.equal(threadName(sessions, A), "要删掉的名字");
  writeFileSync(`${index}.tmp`, entry(B, "留下的名字"));
  renameSync(`${index}.tmp`, index);
  assert.equal(threadName(sessions, A), null);
  assert.equal(threadName(sessions, B), "留下的名字");
});

test("without a name, the title is the start of the first message the user sent", () => {
  const sessions = home();
  assert.equal(firstMessage([{ type: "session_meta", payload: {} }, message("  帮我看看\n这张图  "), message("第二条")]), "帮我看看 这张图");
  assert.equal(firstMessage([{ type: "event_msg", payload: { type: "user_message", message: "   " } }]), null);
  const long = "一".repeat(45);
  assert.equal(threadTitle(sessions, A, [message(long)]), `${"一".repeat(40)}…`);
  assert.equal(threadTitle(sessions, A, []), null, "a thread that has not started has no title");
  writeFileSync(sessionIndexOf(sessions), entry(A, "有名字的任务"));
  assert.equal(threadTitle(sessions, A, [message(long)]), "有名字的任务");
});
