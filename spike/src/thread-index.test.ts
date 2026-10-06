// Purpose: P2 — the thread index read from rollouts: stable ids in history order, turn numbers, incremental
// re-reads of an appended file, and paginated segments chained through history_base.
// v0.1-10/11 — compressed rollouts, new rollouts found in today's folder between full walks, a moved rollout found
// again, and pixel fingerprints shared through the cache folder. v0.1-12 — a fork's history in an archived task's page.
// v0.1-13 — a history whose earlier page is gone for good.
// Input: synthetic rollouts in a temporary directory; output: Node test assertions only.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { zstdCompressSync } from "node:zlib";
import { buildIndex, hasRollout, loadThreadIndex, readThreadHistory, setPixelCache, threadsStartedSince } from "../../plugin/src/thread-index.ts";
import { startThread, todayFolder } from "./testfixtures.ts";
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

test("a rollout Codex compressed after a week (.jsonl.zst) is read; once Codex restores the plain file, that one counts", () => {
  const { dir, day } = sessions();
  const plain = join(day, `rollout-2026-09-24T10-00-00-${THREAD}.jsonl`);
  const content = line("session_meta", { id: THREAD }) + turn("t1") + upload("msg_1", "t1", "a.png", red);
  writeFileSync(`${plain}.zst`, zstdCompressSync(Buffer.from(content)));
  assert.equal(hasRollout(dir, THREAD), true);
  assert.deepEqual(loadThreadIndex(dir, THREAD).images.map((i) => i.name), ["a.png"]);
  // To append, Codex writes the plain file back and then removes the compressed one.
  writeFileSync(plain, content + turn("t2") + upload("msg_2", "t2", "b.png", blue));
  rmSync(`${plain}.zst`);
  assert.deepEqual(loadThreadIndex(dir, THREAD).images.map((i) => i.name), ["a.png", "b.png"]);
});

test("new rollouts in today's folder are found between full walks; a moved rollout is found again when a read misses it", () => {
  const { dir, day } = sessions();
  const name = `rollout-2026-09-24T10-00-00-${THREAD}.jsonl`;
  writeFileSync(join(day, name), line("session_meta", { id: THREAD }) + turn("t1") + upload("msg_1", "t1", "a.png", red));
  assert.equal(loadThreadIndex(dir, THREAD).images.length, 1);
  const NEW = "01a0d301-0000-7000-8000-0000000000e1";
  assert.equal(hasRollout(dir, NEW), false);
  startThread(dir, NEW, {}, 1_000);
  assert.equal(hasRollout(dir, NEW), true, "without waiting for the next full walk");
  // A later page of a thread is not a new thread.
  writeFileSync(join(todayFolder(dir), `rollout-2026-09-25T10-00-00-${NEW}_01a0d301-0000-7000-8000-0000000000e2.jsonl`), line("session_meta", { id: NEW }));
  assert.deepEqual(threadsStartedSince(dir, Date.now() - 60_000).map((entry) => entry.threadId), [NEW]);
  const elsewhere = join(dir, "2026", "08", "01");
  mkdirSync(elsewhere, { recursive: true });
  renameSync(join(day, name), join(elsewhere, name));
  assert.equal(loadThreadIndex(dir, THREAD).images.length, 1);
});

test("pixel fingerprints are shared through the cache folder: a stored one is used instead of decoding again", () => {
  const cache = mkdtempSync(join(tmpdir(), "cam-pixels-"));
  setPixelCache(cache);
  try {
    const { dir, day } = sessions();
    const green = png(3, 5, () => [0, 200, 0]);
    const olive = png(5, 3, () => [120, 120, 0]);
    writeFileSync(join(day, `rollout-2026-09-24T10-00-00-${THREAD}.jsonl`), line("session_meta", { id: THREAD }) + turn("t1") + upload("msg_1", "t1", "g.png", green) + upload("msg_2", "t1", "o.png", olive));
    const idOf = (bytes: Buffer) => createHash("sha256").update(bytes.toString("base64")).digest("hex");
    const oliveId = idOf(olive);
    mkdirSync(join(cache, oliveId.slice(0, 2)), { recursive: true });
    writeFileSync(join(cache, oliveId.slice(0, 2), oliveId), "f".repeat(64));
    const index = loadThreadIndex(dir, THREAD);
    assert.equal(index.images[1].pixelSha256, "f".repeat(64), "stored by another process");
    assert.match(index.images[0].pixelSha256 ?? "", /^[0-9a-f]{64}$/);
    assert.equal(readFileSync(join(cache, idOf(green).slice(0, 2), idOf(green)), "utf8"), index.images[0].pixelSha256, "decoded once, stored for the others");
  } finally {
    setPixelCache(null);
  }
});

test("a fork's history may start in a page of a task the user archived, before or after the panel first read it", () => {
  const PARENT = "01a0d301-0000-7000-8000-0000000000aa";
  const PAGE = "01a0d301-0000-7000-8000-0000000000ab";
  const pageName = `rollout-2026-09-23T10-00-00-${PARENT}_${PAGE}.jsonl`;
  const parentPage = line("session_meta", { id: PARENT }) + turn("t1") + upload("msg_1", "t1", "a.png", red);
  const fork = line("session_meta", { id: THREAD, forked_from_id: PARENT, history_base: { thread_id: PAGE, end_byte_offset: Buffer.byteLength(parentPage) } }) + turn("t2") + upload("msg_2", "t2", "b.png", blue);
  for (const archivedFirst of [true, false]) {
    const root = mkdtempSync(join(tmpdir(), "cam-archived-"));
    const dir = join(root, "sessions");
    const archived = join(root, "archived_sessions");
    const parentDay = join(dir, "2026", "09", "23");
    const day = join(dir, "2026", "09", "25");
    for (const folder of [archived, parentDay, day]) mkdirSync(folder, { recursive: true });
    writeFileSync(join(archivedFirst ? archived : parentDay, pageName), parentPage + upload("msg_x", "t1", "after-fork.png", blue));
    writeFileSync(join(day, `rollout-2026-09-25T18-00-00-${THREAD}.jsonl`), fork);
    assert.deepEqual(loadThreadIndex(dir, THREAD).images.map((i) => i.name), ["a.png", "b.png"], archivedFirst ? "archived before" : "not archived yet");
    if (!archivedFirst) {
      renameSync(join(parentDay, pageName), join(archived, pageName));
      assert.deepEqual(loadThreadIndex(dir, THREAD).images.map((i) => i.name), ["a.png", "b.png"], "archived after the first read");
    }
  }
});

test("when a page the history starts in is gone for good (its task deleted), the rest is read and the gap reported", () => {
  const { dir, day } = sessions();
  const GONE = "01a0d301-0000-7000-8000-0000000000dd";
  writeFileSync(join(day, `rollout-2026-09-24T10-00-00-${THREAD}.jsonl`),
    line("session_meta", { id: THREAD, forked_from_id: GONE, history_base: { thread_id: GONE, end_byte_offset: 1234 } }) + turn("t2") + upload("msg_2", "t2", "b.png", blue));
  const missing: string[] = [];
  assert.deepEqual(buildIndex(THREAD, readThreadHistory(dir, THREAD, missing)).images.map((i) => [i.id, i.name]), [["IMG-001", "b.png"]]);
  assert.deepEqual(missing, [GONE]);
  assert.deepEqual(loadThreadIndex(dir, THREAD).images.map((i) => i.name), ["b.png"], "the engine reads what is left too");
  assert.throws(() => readThreadHistory(dir, "01a0d301-0000-7000-8000-0000000000ee"), /no rollout found/, "a thread without a page of its own still has no history");
});

// v0.3: what the model fetched with cam_view_image is the same image again, kept apart as a copy of the original.
test("an image the model fetched with cam_view_image is a copy without an id, and the ids after it stay", () => {
  const { dir, day } = sessions();
  const fetched = (callId: string, label: string, bytes: Buffer) =>
    line("response_item", { type: "custom_tool_call", call_id: callId, name: "exec", input: 'await tools.mcp__codex_attachment_manager__cam_view_image({ids:["IMG-001"]})' }) +
    line("response_item", { type: "custom_tool_call_output", call_id: callId, output: [{ type: "input_text", text: "Script completed" }, { type: "input_text", text: label }, { type: "input_image", image_url: url(bytes) }] });
  writeFileSync(join(day, `rollout-2026-09-24T10-00-00-${THREAD}.jsonl`),
    line("session_meta", { id: THREAD }) +
    turn("t1") + upload("msg_1", "t1", "a.png", red) +
    turn("t2") + fetched("c1", "[图片 IMG-001 取回的原图｜a.png｜用户上传｜第 1 轮｜4×4]", red) +
    // A line naming IMG-001 before an image that is not IMG-001 makes no copy.
    fetched("c2", "[Image IMG-001 fetched original | a.png | uploaded by the user | turn 1 | 4×4]", blue) +
    turn("t3") + upload("msg_3", "t3", "b.png", blue));
  const index = loadThreadIndex(dir, THREAD);
  assert.deepEqual(index.images.map((image) => [image.id, image.turn]), [["IMG-001", 1], ["IMG-002", 2], ["IMG-003", 3]]);
  assert.deepEqual([...index.copies.values()], [{ key: "custom_tool_call_output:c1#0", of: "IMG-001", turn: 2 }]);
  assert.equal(index.byKey.has("custom_tool_call_output:c1#0"), false);
});
