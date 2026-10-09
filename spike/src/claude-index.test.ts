// Purpose: v0.4 — the image timeline of a Claude Code session (claude-index.ts): ids in conversation order, keys,
// kinds and names, turns, branches and compaction, copies the fetch tool returned, and the session's title.
// Input: synthetic transcripts (claude-fixtures.ts) and temporary files; output: Node test assertions only.

import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { activeChain, buildClaudeIndex, claudeImageData, loadClaudeIndex, transcriptOf } from "../../plugin/src/claude-index.ts";
import { image, pngA, pngB, pngC, text, transcript, usualSession } from "./claude-fixtures.ts";

test("images get ids in conversation order: pasted ones by record, tool ones by tool_use_id", () => {
  const { t, p1, p3 } = usualSession();
  const index = buildClaudeIndex("s", t.records);
  assert.deepEqual(index.images.map((entry) => [entry.id, entry.key, entry.kind, entry.turn, entry.name]), [
    ["IMG-001", `${p1}#0`, "upload", 1, null],
    ["IMG-002", `${p1}#1`, "upload", 1, null],
    ["IMG-003", "tool:toolu_1#0", "view", 2, "c.png"],
    ["IMG-004", `${p3}#0`, "upload", 3, null],
  ]);
  assert.equal(index.turns, 3);
  assert.equal(index.images[2].width, 16);
  assert.deepEqual(index.uploads.map((upload) => [upload.uuid, upload.contentIds.length, upload.compacted]), [[p1, 2, false], [p3, 1, false]]);
  assert.equal(claudeImageData(index, index.images[2]), pngC);
  assert.equal(claudeImageData(index, index.images[1]), pngB);
});

test("the conversation is the branch the newest message is on; sidechains and attachments do not change it", () => {
  const t = transcript();
  const p1 = t.prompt([image(pngA), text("first")]);
  const a1 = t.assistant(text("ok"));
  t.prompt([image(pngB), text("abandoned")]);
  t.assistant(text("old answer"));
  // A rewind: a new prompt from the first answer.
  const p2 = t.prompt([image(pngC), text("edited")], {}, a1);
  t.attachment();
  t.assistant(text("sub"), { isSidechain: true });
  const chain = activeChain(t.records);
  assert.deepEqual(chain.filter((record) => record.type === "user").map((record) => record.uuid), [p1, p2]);
  const index = buildClaudeIndex("s", t.records);
  assert.deepEqual(index.images.map((entry) => entry.key), [`${p1}#0`, `${p2}#0`]);
});

test("compaction: the chain goes on across the boundary, and images before it are marked compacted", () => {
  const t = transcript();
  const p1 = t.prompt([image(pngA), text("first")]);
  t.assistant(text("ok"));
  t.boundary();
  t.summary();
  const p2 = t.prompt([image(pngB), text("after")]);
  const index = buildClaudeIndex("s", t.records);
  assert.deepEqual(index.images.map((entry) => [entry.id, entry.key, entry.compacted, entry.turn]), [["IMG-001", `${p1}#0`, true, 1], ["IMG-002", `${p2}#0`, false, 2]]);
  assert.deepEqual(index.uploads.map((upload) => upload.compacted), [true, false]);
});

test("an image our fetch tool returned is a copy of the original: no id, recorded with its turn", () => {
  const t = transcript();
  t.prompt([image(pngA), text("look")]);
  t.assistant(text("red"));
  t.prompt("look again");
  t.assistant({ type: "tool_use", id: "toolu_9", name: "mcp__plugin_codex-attachment-manager_codex_attachment_manager__cam_view_image", input: { ids: ["IMG-001"] } });
  t.toolResult("toolu_9", [text("[图片 IMG-001 取回的原图｜未命名｜用户上传｜第 1 轮｜8×8]"), image(pngA)]);
  t.prompt([image(pngB), text("new")]);
  const index = buildClaudeIndex("s", t.records);
  assert.deepEqual(index.images.map((entry) => entry.id), ["IMG-001", "IMG-002"]);
  assert.deepEqual([...index.copies.values()], [{ key: "tool:toolu_9#0", of: "IMG-001", turn: 2 }]);
});

test("the latest reply's text is kept for the ids the model asked for; a turn without a reply falls back", () => {
  const { t } = usualSession();
  assert.deepEqual(buildClaudeIndex("s", t.records).replies, ["Same red square."]);
  t.prompt("next");
  assert.deepEqual(buildClaudeIndex("s", t.records).replies, ["Same red square."]);
  const u = transcript();
  u.prompt("q");
  u.assistant(text("need IMG-002"));
  u.prompt("r");
  assert.deepEqual(buildClaudeIndex("s", u.records).replies, ["need IMG-002"]);
});

test("the title is the latest custom title, else the start of the first prompt", () => {
  const { t } = usualSession();
  assert.equal(buildClaudeIndex("s", t.records).title, "What are these?");
  t.records.push({ type: "custom-title", customTitle: "Keyframes", sessionId: "s" });
  assert.equal(buildClaudeIndex("s", t.records).title, "Keyframes");
});

test("a transcript is found by session id under projects/, and read again as it grows", () => {
  const home = mkdtempSync(join(tmpdir(), "cam-claude-"));
  const id = "11111111-2222-4333-8444-555555555555";
  mkdirSync(join(home, "projects", "D--work"), { recursive: true });
  const file = join(home, "projects", "D--work", `${id}.jsonl`);
  const t = transcript();
  t.prompt([image(pngA), text("one")]);
  writeFileSync(file, t.records.map((record) => JSON.stringify(record)).join("\n") + "\n");
  assert.equal(transcriptOf(id, home), file);
  assert.equal(transcriptOf("not-a-session", home), null);
  assert.equal(loadClaudeIndex(id, home).images.length, 1);
  t.assistant(text("ok"));
  t.prompt([image(pngB), text("two")]);
  appendFileSync(file, t.records.slice(1).map((record) => JSON.stringify(record)).join("\n") + "\n");
  assert.deepEqual(loadClaudeIndex(id, home).images.map((entry) => entry.id), ["IMG-001", "IMG-002"]);
  assert.equal(loadClaudeIndex("22222222-2222-4333-8444-555555555555", home).images.length, 0);
});
