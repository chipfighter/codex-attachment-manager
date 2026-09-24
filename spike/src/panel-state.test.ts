// Purpose: P3-3 — the panel's data: image states, the ids the model asked for, check/uncheck, and thumbnails.
// P4 — previews and other formats, and threads without a rollout yet.
// Input: synthetic rollouts in temporary folders; output: Node test assertions only.

import assert from "node:assert/strict";
import test from "node:test";
import { decodePng } from "./png.ts";
import { applySelection, imageFor, loadPanelState, requestedIds } from "./panel-state.ts";
import { assistant, line, red, sampleSessions, THREAD, turn } from "./testfixtures.ts";
import { shrink } from "./thumbnail.ts";

const records = (text: string) => text.trim().split("\n").map((raw) => JSON.parse(raw));

test("the ids the model asked for come from its latest reply only", () => {
  assert.deepEqual(requestedIds(records(turn("t1") + assistant("需要 IMG-001", "t1") + turn("t2") + assistant("好的，需要 “IMG-004” 和 IMG-002。", "t2"))), ["IMG-004", "IMG-002"]);
  assert.deepEqual(requestedIds(records(turn("t1") + assistant("need IMG-007 to answer", "t1") + turn("t2"))), ["IMG-007"], "a turn still running falls back to the one before");
  assert.deepEqual(requestedIds(records(turn("t1") + assistant("IMG-003 与 IMG-002 相同", "t1"))), [], "mentioning an id is not asking for it");
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
  assert.equal(state.lastRequest, null);
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

test("a thread without a rollout yet shows an empty panel instead of an error", () => {
  const options = sampleSessions();
  const state = loadPanelState("01a0d301-0000-7000-8000-00000000ffff", options);
  assert.deepEqual([state.images, state.turns, state.totals.images], [[], 0, 0]);
});
