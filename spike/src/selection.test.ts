// Purpose: P3 — a forked thread starts with what its parent had unchecked when the fork was made, then the two are
// independent; ordinary threads are unaffected. Covers forks of forks and threads whose rollout appears later.
// Input: synthetic rollouts and selection files in temporary folders; output: Node test assertions only.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { hasUnchecked, needsRewrite } from "../../plugin/src/proxy.ts";
import { effectiveSelection, readSelection, writeSelection } from "../../plugin/src/selection.ts";
import { startThread } from "./testfixtures.ts";

const PARENT = "01a0d301-0000-7000-8000-0000000000f0";
const FORK = "01a0d301-0000-7000-8000-0000000000f1";
const FORK2 = "01a0d301-0000-7000-8000-0000000000f2";
const PLAIN = "01a0d301-0000-7000-8000-0000000000f3";
const LATE = "01a0d301-0000-7000-8000-0000000000f4";

function setup() {
  const root = mkdtempSync(join(tmpdir(), "cam-fork-"));
  const day = join(root, "sessions", "2026", "09", "24");
  mkdirSync(day, { recursive: true });
  const rollout = (id: string, meta: Record<string, unknown>) =>
    writeFileSync(join(day, `rollout-2026-09-24T10-00-00-${id}.jsonl`), `${JSON.stringify({ type: "session_meta", payload: { id, ...meta } })}\n`);
  rollout(PARENT, { timestamp: "2026-09-24T10:00:00Z" });
  rollout(FORK, { forked_from_id: PARENT, timestamp: "2026-09-24T12:00:00Z" });
  rollout(FORK2, { forked_from_id: FORK, timestamp: "2026-09-24T12:30:00Z" });
  rollout(PLAIN, { timestamp: "2026-09-24T10:00:00Z" });
  const dir = join(root, "selection");
  writeSelection({ threadId: PARENT, unchecked: { "msg_1#0": { id: "IMG-001", at: "2026-09-24T11:00:00Z" }, "msg_2#0": { id: "IMG-002", at: "2026-09-24T13:00:00Z" } } }, dir);
  return { sessionsDir: join(root, "sessions"), day, dir, rollout };
}

test("a fork takes what its parent had unchecked by the time of the fork, and keeps it as its own", () => {
  const { sessionsDir, dir } = setup();
  const fork = effectiveSelection(FORK, sessionsDir, dir);
  assert.deepEqual(Object.values(fork.unchecked).map((entry) => entry.id), ["IMG-001"], "IMG-002 was unchecked after the fork");
  assert.equal(fork.inheritedFrom, PARENT);
  assert.equal(existsSync(join(dir, `${FORK}.json`)), true);
  assert.equal(hasUnchecked(FORK, dir, sessionsDir), true);
});

test("after the fork the two selections are independent", () => {
  const { sessionsDir, dir } = setup();
  effectiveSelection(FORK, sessionsDir, dir);
  writeSelection({ threadId: FORK, unchecked: {} }, dir);
  assert.equal(Object.keys(readSelection(PARENT, dir).unchecked).length, 2, "checking in the fork leaves the parent alone");
  writeSelection({ threadId: PARENT, unchecked: {} }, dir);
  writeSelection({ threadId: FORK, unchecked: { "msg_1#0": { id: "IMG-001", at: "2026-09-24T14:00:00Z" } } }, dir);
  assert.equal(Object.keys(effectiveSelection(FORK, sessionsDir, dir).unchecked).length, 1, "the parent's change does not reach the fork");
});

test("a fork of a fork asks its own parent; ordinary threads stay empty and get no file", () => {
  const { sessionsDir, dir } = setup();
  assert.deepEqual(Object.values(effectiveSelection(FORK2, sessionsDir, dir).unchecked).map((entry) => entry.id), ["IMG-001"]);
  assert.deepEqual(effectiveSelection(PLAIN, sessionsDir, dir).unchecked, {});
  assert.equal(existsSync(join(dir, `${PLAIN}.json`)), false);
  assert.equal(hasUnchecked(PLAIN, dir, sessionsDir), false);
});

test("a thread whose rollout is not written yet is looked up again later", () => {
  const { sessionsDir, dir } = setup();
  assert.deepEqual(effectiveSelection(LATE, sessionsDir, dir).unchecked, {});
  // Codex files a new rollout in today's folder.
  startThread(sessionsDir, LATE, { forked_from_id: PARENT, timestamp: "2026-09-24T12:00:00Z" });
  assert.deepEqual(Object.values(effectiveSelection(LATE, sessionsDir, dir).unchecked).map((entry) => entry.id), ["IMG-001"]);
});

// v0.3: automatic selection's switch and pins are inherited the same way. FORK was made at 12:00.
test("a fork takes automatic selection when it was on at the fork, and the pins made before it", () => {
  const { sessionsDir, dir } = setup();
  const pinned = { "msg_1#0": { id: "IMG-001", at: "2026-09-24T11:40:00Z" }, "msg_2#0": { id: "IMG-002", at: "2026-09-24T13:00:00Z" } };
  writeSelection({ threadId: PARENT, unchecked: {}, auto: true, autoAt: "2026-09-24T11:30:00Z", autoSince: "2026-09-24T11:30:00Z", pinned }, dir);
  const fork = effectiveSelection(FORK, sessionsDir, dir);
  assert.equal(fork.auto, true);
  assert.deepEqual(Object.values(fork.pinned ?? {}).map((entry) => entry.id), ["IMG-001"]);
  assert.equal(needsRewrite(FORK, dir, sessionsDir), true);
});

test("switched on again after the fork, the switch stays the parent's; first used after it, nothing comes along", () => {
  const again = setup();
  writeSelection({ threadId: PARENT, unchecked: {}, auto: true, autoAt: "2026-09-24T12:30:00Z", autoSince: "2026-09-24T11:00:00Z" }, again.dir);
  const fork = effectiveSelection(FORK, again.sessionsDir, again.dir);
  assert.equal(fork.auto, false);
  assert.equal(needsRewrite(FORK, again.dir, again.sessionsDir), true, "copies fetched before the fork are still left out of its requests");
  const later = setup();
  writeSelection({ threadId: PARENT, unchecked: {}, auto: true, autoAt: "2026-09-24T12:30:00Z", autoSince: "2026-09-24T12:30:00Z" }, later.dir);
  assert.equal(effectiveSelection(FORK, later.sessionsDir, later.dir).auto, undefined);
  assert.equal(needsRewrite(FORK, later.dir, later.sessionsDir), false);
});
