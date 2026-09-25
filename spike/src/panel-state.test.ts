// Purpose: P3-3 — the panel's data: image states, the ids the model asked for, check/uncheck, and thumbnails.
// P4 — previews and other formats, and threads without a rollout yet. v0.1-9 — the task's name as the title.
// v0.1-13 — a fork whose earlier history is gone.
// Input: synthetic rollouts in temporary folders; output: Node test assertions only.

import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { decodePng } from "../../plugin/src/png.ts";
import { applySelection, imageFor, loadPanelState, requestedIds, sendInfo } from "../../plugin/src/panel-state.ts";
import { requestStatsDirOf } from "../../plugin/src/paths.ts";
import { recordRequest } from "../../plugin/src/request-stats.ts";
import { assistant, line, red, sampleSessions, THREAD, turn, upload } from "./testfixtures.ts";
import { shrink } from "../../plugin/src/thumbnail.ts";

const records = (text: string) => text.trim().split("\n").map((raw) => JSON.parse(raw));

test("the ids the model asked for come from its latest reply only", () => {
  assert.deepEqual(requestedIds(records(turn("t1") + assistant("需要 IMG-001", "t1") + turn("t2") + assistant("好的，需要 “IMG-004” 和 IMG-002。", "t2"))), ["IMG-004", "IMG-002"]);
  assert.deepEqual(requestedIds(records(turn("t1") + assistant("need IMG-007 to answer", "t1") + turn("t2"))), ["IMG-007"], "a turn still running falls back to the one before");
  assert.deepEqual(requestedIds(records(turn("t1") + assistant("IMG-003 与 IMG-002 相同", "t1"))), [], "mentioning an id is not asking for it");
  assert.deepEqual(requestedIds(records(turn("t1") + assistant("To answer that I need \"IMG-004\" and IMG-002.", "t1"))), ["IMG-004", "IMG-002"], "the English wording, quoted");
});

test("panel state lists every image with checked, same-content and requested flags", () => {
  const options = sampleSessions();
  const state = loadPanelState(THREAD, options);
  assert.deepEqual(state.images.map((image) => [image.id, image.name, image.checked, image.sameAs, image.requested]), [
    ["IMG-001", "a.png", true, [], true],
    ["IMG-002", "b.png", true, ["IMG-003"], false],
    ["IMG-003", "b-copy.png", true, ["IMG-002"], false],
  ]);
  assert.deepEqual(state.requested, ["IMG-001"]);
  assert.equal(state.totals.checkedBytes, state.totals.allBytes);
  assert.deepEqual(state.send, { baseline: null, last: null, notice: null });
  assert.deepEqual(state.images.map((image) => [image.inLastRequest, image.inNextRequest]), [[null, true], [null, true], [null, true]], "without a recorded request every image counts");
});

test("the size baseline: images the last request carried, images added since, and images compacted away", () => {
  const options = sampleSessions(turn("t3") + line("response_item", {
    type: "message", id: "msg_3", role: "user",
    content: [{ type: "input_image", image_url: `data:image/png;base64,${red.toString("base64")}` }],
    internal_chat_message_metadata_passthrough: { turn_id: "t3" },
  }));
  // The last request (turn 2) carried IMG-002 and IMG-003; IMG-001 had been compacted away; IMG-004 came later.
  recordRequest(THREAD, { at: "2026-09-24T12:00:00Z", transport: "http", turnId: "t2", decodedBytes: 5000, imageSizes: { "msg_1#1": 100, "msg_1#2": 100 }, rewrite: { replaced: [{ id: "IMG-003" }], decodedBefore: 5000, decodedAfter: 4500 } }, requestStatsDirOf(options.dataRoot));
  const state = loadPanelState(THREAD, options);
  assert.deepEqual(state.images.map((image) => [image.id, image.inLastRequest, image.inNextRequest]), [
    ["IMG-001", false, false], ["IMG-002", true, true], ["IMG-003", true, true], ["IMG-004", false, true],
  ]);
  assert.deepEqual(state.send, {
    baseline: { at: "2026-09-24T12:00:00Z", bytes: 5000 },
    last: { at: "2026-09-24T12:00:00Z", bytesBefore: 5000, bytesAfter: 4500, replaced: 1, skipped: false },
    notice: null,
  });
});

test("the panel is told when the engine could not rewrite, or a WebSocket turn kept the unchecked images", () => {
  const http = { at: "t1", transport: "http", decodedBytes: 900, rewrite: { skipped: "thread index: Error: boom" } };
  assert.deepEqual(sendInfo({ latest: http, lastHttp: http }).notice, { kind: "skipped", at: "t1", reason: "index" });
  assert.deepEqual(sendInfo({ latest: { ...http, rewrite: { skipped: "rewrite failed: x" } }, lastHttp: { ...http, rewrite: { skipped: "rewrite failed: x" } } }).notice?.kind, "skipped");
  const busy = { at: "t2", transport: "websocket", event: "active-while-unchecked" };
  assert.deepEqual(sendInfo({ latest: busy, lastHttp: http }).notice, { kind: "websocket", at: "t2" });
  assert.equal(sendInfo({ latest: { at: "t3", transport: "http", decodedBytes: 800, rewrite: { replaced: [] } }, lastHttp: null }).notice, null);
  assert.equal(sendInfo({ latest: http, lastHttp: http }).baseline, null, "a request without image sizes is no baseline");
});

test("check and uncheck are kept per thread and validated", () => {
  const options = sampleSessions();
  let state = applySelection(THREAD, { uncheck: ["IMG-001", "IMG-003"] }, options);
  assert.deepEqual(state.images.filter((image) => !image.checked).map((image) => image.id), ["IMG-001", "IMG-003"]);
  assert.equal(state.totals.unchecked, 2);
  assert.ok(state.totals.checkedBytes < state.totals.allBytes);
  state = applySelection(THREAD, { check: ["IMG-001"] }, options);
  assert.deepEqual(loadPanelState(THREAD, options).images.filter((image) => !image.checked).map((image) => image.id), ["IMG-003"]);
  state = applySelection(THREAD, { checkAll: true }, options);
  assert.equal(state.totals.unchecked, 0);
  assert.throws(() => applySelection(THREAD, { uncheck: ["IMG-099"] }, options), /not an image of this thread/);
});

test("thumbnails keep the aspect ratio and fit the requested size", () => {
  const options = sampleSessions();
  const thumb = imageFor(THREAD, "IMG-001", 32, options);
  assert.ok(thumb.dataUrl?.startsWith("data:image/png;base64,"));
  const decoded = decodePng(Buffer.from(thumb.dataUrl!.split(",")[1], "base64"));
  assert.deepEqual([decoded.width, decoded.height], [32, 16]);
  const averaged = shrink(2, 1, Buffer.from([0, 0, 0, 255, 200, 100, 50, 255]), 1);
  assert.deepEqual([...averaged.pixels], [100, 50, 25, 255], "a box filter averages the covered pixels");
});

test("images within the requested size, and formats other than PNG, reach the panel as they are", () => {
  const jpeg = Buffer.from("ffd8ffe000104a46494600010100000100010000ffd9", "hex").toString("base64");
  const options = sampleSessions(turn("t3") + line("response_item", {
    type: "message", id: "msg_3", role: "user",
    content: [{ type: "input_image", image_url: `data:image/jpeg;base64,${jpeg}` }],
    internal_chat_message_metadata_passthrough: { turn_id: "t3" },
  }));
  assert.equal(imageFor(THREAD, "IMG-001", 160, options).dataUrl, `data:image/png;base64,${red.toString("base64")}`);
  assert.equal(imageFor(THREAD, "IMG-004", 160, options).dataUrl, `data:image/jpeg;base64,${jpeg}`);
  assert.throws(() => imageFor(THREAD, "IMG-099", 160, options), /not an image of this thread/);
});

test("a thread without a rollout yet shows an empty panel instead of an error, and says it has not started", () => {
  const options = sampleSessions();
  const state = loadPanelState("01a0d301-0000-7000-8000-00000000ffff", options);
  assert.deepEqual([state.images, state.turns, state.totals.images, state.started], [[], 0, 0, false]);
  assert.equal(loadPanelState(THREAD, options).started, true);
});

test("the title is the task's name, else the start of its first message; a thread that has not started has none", () => {
  const options = sampleSessions(line("event_msg", { type: "user_message", message: "第一条消息" }));
  assert.equal(loadPanelState(THREAD, options).title, "第一条消息");
  writeFileSync(join(dirname(options.sessionsDir), "session_index.jsonl"), `${JSON.stringify({ id: THREAD, thread_name: "改图任务", updated_at: "2026-09-25T10:00:00Z" })}
`);
  assert.equal(loadPanelState(THREAD, options).title, "改图任务");
  assert.equal(loadPanelState("01a0d301-0000-7000-8000-00000000ffff", options).title, null);
});

test("a fork whose earlier history is gone lists the images left and says part of the history is missing", () => {
  const options = sampleSessions();
  const FORK = "01a0d301-0000-7000-8000-00000000abce";
  writeFileSync(join(options.sessionsDir, "2026", "09", "24", `rollout-2026-09-24T11-00-00-${FORK}.jsonl`),
    line("session_meta", { id: FORK, forked_from_id: "01a0d301-0000-7000-8000-00000000dead", history_base: { thread_id: "01a0d301-0000-7000-8000-00000000dead", end_byte_offset: 99 } }) +
    turn("t5") + upload("msg_5", "t5", [["later.png", red]]));
  const state = loadPanelState(FORK, options);
  assert.deepEqual([state.historyMissing, state.started, state.images.map((image) => image.name)], [true, true, ["later.png"]]);
  assert.equal(loadPanelState(THREAD, options).historyMissing, false);
});
