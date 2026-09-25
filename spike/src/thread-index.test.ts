// Purpose: P2 — the thread index read from rollouts: stable ids in history order, turn numbers, incremental
// re-reads of an appended file, and paginated segments chained through history_base.
// Input: synthetic rollouts in a temporary directory; output: Node test assertions only.

import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadThreadIndex } from "../../plugin/src/thread-index.ts";
import { png } from "./testkit.ts";

const THREAD = "01a0d301-0000-7000-8000-000000000001";
const url = (bytes: Buffer) => `data:image/png;base64,${bytes.toString("base64")}`;
const red = png(4, 4, () => [255, 0, 0]);
const blue = png(6, 2, () => [0, 0, 255]);

const line = (type: string, payload: Record<string, any>) => `${JSON.stringify({ timestamp: "2026-09-24T10:00:00Z", type, payload })}\n`;
const turn = (id: string) => line("event_msg", { type: "task_started", turn_id: id });
const upload = (id: string, turnId: string, name: string, bytes: Buffer) => line("response_item", {
  type: "message", id, role: "user",
  content: [{ type: "input_text", text: `<image name=[Image #1] path="C:\\w\\${name}">` }, { type: "input_image", image_url: url(bytes) }, { type: "input_text", text: "</image>" }],
  internal_chat_message_metadata_passthrough: { turn_id: turnId },
});

function sessions(): { dir: string; day: string } {
  const dir = mkdtempSync(join(tmpdir(), "cam-sessions-"));
  const day = join(dir, "2026", "09", "24");
  mkdirSync(day, { recursive: true });
  return { dir, day };
}

test("ids follow history order, turns come from task_started, and a repeated item is counted once", () => {
  const { dir, day } = sessions();
  writeFileSync(join(day, `rollout-2026-09-24T10-00-00-${THREAD}.jsonl`),
    line("session_meta", { id: THREAD }) + turn("t1") + upload("msg_1", "t1", "a.png", red) + turn("t2") + upload("msg_2", "t2", "b.png", blue) + upload("msg_1", "t1", "a.png", red));
  const index = loadThreadIndex(dir, THREAD);
  assert.deepEqual(index.images.map((i) => [i.id, i.name, i.turn, i.width, i.height]), [["IMG-001", "a.png", 1, 4, 4], ["IMG-002", "b.png", 2, 6, 2]]);
  assert.equal(index.turns, 2);
  assert.ok(index.images[0].pixelSha256);
});

test("appending to the rollout adds new ids and keeps the old ones", () => {
  const { dir, day } = sessions();
  const file = join(day, `rollout-2026-09-24T10-00-00-${THREAD}.jsonl`);
  writeFileSync(file, line("session_meta", { id: THREAD }) + turn("t1") + upload("msg_1", "t1", "a.png", red));
  assert.deepEqual(loadThreadIndex(dir, THREAD).images.map((i) => i.id), ["IMG-001"]);
  // A half-written last line is left for the next read.
  appendFileSync(file, turn("t2") + upload("msg_2", "t2", "b.png", blue).slice(0, 40));
  assert.deepEqual(loadThreadIndex(dir, THREAD).images.map((i) => i.name), ["a.png"]);
  appendFileSync(file, upload("msg_2", "t2", "b.png", blue).slice(40));
  assert.deepEqual(loadThreadIndex(dir, THREAD).images.map((i) => [i.id, i.name, i.turn]), [["IMG-001", "a.png", 1], ["IMG-002", "b.png", 2]]);
});

test("a later segment inherits its base segment only up to history_base.end_byte_offset", () => {
  const { dir, day } = sessions();
  const first = line("session_meta", { id: THREAD }) + turn("t1") + upload("msg_1", "t1", "a.png", red);
  writeFileSync(join(day, `rollout-2026-09-24T10-00-00-${THREAD}.jsonl`), first + upload("msg_x", "t1", "dropped.png", blue));
  const segment = "01a0d301-0000-7000-8000-00000000000b";
  writeFileSync(join(day, `rollout-2026-09-24T10-05-00-${THREAD}_${segment}.jsonl`),
    line("session_meta", { id: THREAD, history_base: { thread_id: THREAD, end_byte_offset: Buffer.byteLength(first) } }) + turn("t2") + upload("msg_2", "t2", "b.png", blue));
  assert.deepEqual(loadThreadIndex(dir, THREAD).images.map((i) => [i.id, i.name]), [["IMG-001", "a.png"], ["IMG-002", "b.png"]]);
});

test("a fork inherits its parent's history up to the fork point, read from the parent's own file", () => {
  const { dir, day } = sessions();
  const PARENT = "01a0d301-0000-7000-8000-0000000000aa";
  const parentHead = line("session_meta", { id: PARENT }) + turn("t1") + upload("msg_1", "t1", "a.png", red);
  writeFileSync(join(day, `rollout-2026-09-24T09-00-00-${PARENT}.jsonl`), parentHead + turn("t2") + upload("msg_p", "t2", "parent-only.png", blue));
  writeFileSync(join(day, `rollout-2026-09-24T10-00-00-${THREAD}.jsonl`),
    line("session_meta", { id: THREAD, history_base: { thread_id: PARENT, end_byte_offset: Buffer.byteLength(parentHead) } }) + turn("t3") + upload("msg_2", "t3", "b.png", blue));
  assert.deepEqual(loadThreadIndex(dir, THREAD).images.map((i) => [i.id, i.name, i.turn]), [["IMG-001", "a.png", 1], ["IMG-002", "b.png", 2]]);
  assert.deepEqual(loadThreadIndex(dir, PARENT).images.map((i) => i.name), ["a.png", "parent-only.png"], "the parent is unaffected");
});

test("an unnamed image takes the name of an identical named one", () => {
  const { dir, day } = sessions();
  const viewed = line("response_item", { type: "custom_tool_call_output", id: "ctco_1", call_id: "c1", output: [{ type: "input_image", image_url: url(red) }] });
  writeFileSync(join(day, `rollout-2026-09-24T10-00-00-${THREAD}.jsonl`), line("session_meta", { id: THREAD }) + turn("t1") + upload("msg_1", "t1", "a.png", red) + viewed);
  assert.deepEqual(loadThreadIndex(dir, THREAD).images.map((i) => [i.id, i.kind, i.name]), [["IMG-001", "upload", "a.png"], ["IMG-002", "tool", "a.png"]]);
});
