// Purpose: P2 — the rewrite rules: only unchecked images change; duplicate vs plain placeholders; locked results.
// v0.1 — one developer message explains omitted images, so the model does not take back earlier answers.
// v0.1-25 — once anything is left out, each image still sent is marked with its id.
// Input: synthetic request items; output: Node test assertions only.

import assert from "node:assert/strict";
import test from "node:test";
import { findImages, type ImageRef } from "../../plugin/src/images.ts";
import { OMISSION_NOTE, omissionNote, rewriteItems, type Described } from "../../plugin/src/rewrite.ts";
import { png } from "./testkit.ts";

const url = (bytes: Buffer) => `data:image/png;base64,${bytes.toString("base64")}`;
const red = png(4, 4, () => [255, 0, 0]);
const blue = png(4, 4, () => [0, 0, 255]);
const green = png(4, 4, () => [0, 255, 0]);

const tagged = (name: string, n: number, bytes: Buffer) => [
  { type: "input_text", text: `<image name=[Image #${n}] path="C:\\work\\${name}">` },
  { type: "input_image", image_url: url(bytes), detail: "high" },
  { type: "input_text", text: "</image>" },
];
// IMG-001 a.png (red), IMG-002 b.png (blue), IMG-003 b copy.png (blue), IMG-004 view_image of a.png (red),
// IMG-005 hosted generation result (green).
const items = () => [
  { type: "message", id: "msg_dev", role: "developer", content: [{ type: "input_text", text: "instructions" }] },
  { type: "message", id: "msg_1", role: "user", content: [{ type: "input_text", text: "三张图" }, ...tagged("a.png", 1, red), ...tagged("b.png", 2, blue), ...tagged("b copy.png", 3, blue)] },
  { type: "message", id: "msg_2", role: "assistant", content: [{ type: "output_text", text: "收到" }] },
  { type: "custom_tool_call", call_id: "c1", name: "exec", input: 'await tools.view_image({path:"C:\\\\work\\\\a.png"})' },
  { type: "custom_tool_call_output", id: "ctco_1", call_id: "c1", output: [{ type: "input_text", text: "Script completed" }, { type: "input_image", image_url: url(red) }] },
  { type: "image_generation_call", id: "ig_1", status: "completed", result: green.toString("base64") },
];

// Ids in order of appearance, as the thread index assigns them.
function index(list: Array<Record<string, any>>) {
  const refs = findImages(list);
  const byKey = new Map(refs.map((ref, i) => [ref.key, { id: `IMG-00${i + 1}`, name: ref.name, label: ref.label, kind: ref.kind, turn: 1, width: ref.width, height: ref.height } satisfies Described]));
  return { describe: (ref: ImageRef) => byKey.get(ref.key), keys: (...ids: string[]) => new Set(ids.map((id) => [...byKey].find(([, v]) => v.id === id)![0])) };
}
const noPixels = () => null;
const texts = (item: Record<string, any>): string[] => (item.content ?? item.output).map((part: Record<string, any>) => part.text ?? part.type);
const modes = (report: { replaced: Array<{ id: string; mode: string; sameAs: string | null }> }) => report.replaced.map((r) => [r.id, r.mode, r.sameAs]);

test("nothing unchecked: the very same items come back", () => {
  const input = items();
  const { items: out, report } = rewriteItems(input, index(input).describe, new Set(), noPixels);
  assert.equal(out, input);
  assert.deepEqual([report.images, report.replaced.length], [5, 0]);
});

test("an unchecked upload becomes one plain placeholder in place of Codex's tag, image and closing tag", () => {
  const input = items();
  const { describe, keys } = index(input);
  const { items: out, report } = rewriteItems(input, describe, keys("IMG-001", "IMG-004"), noPixels);
  // out[1] is the inserted explanation (next test); the user message follows it.
  const parts = texts(out[2]);
  // The text, IMG-001's placeholder, then IMG-002 and IMG-003, each with its label (a later test) and Codex's 3 parts.
  assert.equal(parts.length, 1 + 1 + 4 + 4);
  assert.match(parts[1], /^\[图片 IMG-001（\[Image #1\]） 已省略｜a\.png｜用户上传｜第 1 轮｜4×4\]\n原图被用户省略以节省上下文，情况见前面的“上下文管理说明”/);
  assert.match(parts[1], /需要 IMG-001/);
  assert.doesNotMatch(parts[1], /C:\\work/, "no local path in the placeholder");
  assert.match(texts(out[5])[1], /^\[图片 IMG-004 已省略｜a\.png｜工具查看的图片｜第 1 轮｜4×4\]\n.*需要 IMG-004/s);
  assert.deepEqual(modes(report), [["IMG-001", "plain", null], ["IMG-004", "plain", null]]);
  assert.equal(out[0], input[0], "untouched items keep their identity");
  assert.equal(input[1].content.length, 10, "the input is not mutated");
});

test("one developer message explains omitted images: seen when they appeared, earlier answers still hold", () => {
  const input = items();
  const { describe, keys } = index(input);
  const { items: out, report } = rewriteItems(input, describe, keys("IMG-001", "IMG-004"), noPixels);
  assert.deepEqual(out[1], { type: "message", role: "developer", content: [{ type: "input_text", text: OMISSION_NOTE }] });
  assert.equal(out.filter((item) => item.role === "developer" && item.content[0].text === OMISSION_NOTE).length, 1, "said once, not per image");
  assert.equal(report.noteAt, 1, "right before the user message of the turn where the first omitted image appeared");
  assert.match(OMISSION_NOTE, /真实存在，你当时收到并看过/);
  assert.match(OMISSION_NOTE, /不要因为现在看不到，就认为之前的回答是猜测或错误，也不要收回或道歉/);
  assert.match(OMISSION_NOTE, /需要 IMG-xxx/);
});

test("once anything is left out, each image still sent carries its id right before it", () => {
  const input = items();
  const { describe, keys } = index(input);
  const { items: out } = rewriteItems(input, describe, keys("IMG-001", "IMG-004"), noPixels);
  const parts = texts(out[2]);
  // Before Codex's own tag, whose label ("[Image #2]") starts again in every message.
  assert.equal(parts[2], "[图片 IMG-002（[Image #2]） 已提供｜b.png｜用户上传｜第 1 轮｜4×4]");
  assert.match(parts[3], /^<image name=\[Image #2\]/);
  assert.equal(parts[4], "input_image");
  assert.equal(parts[6], "[图片 IMG-003（[Image #3]） 已提供｜b copy.png｜用户上传｜第 1 轮｜4×4]");
  const english = rewriteItems(input, describe, keys("IMG-001", "IMG-004"), noPixels, "en").items;
  assert.equal(texts(english[2])[2], "[Image IMG-002 ([Image #2]) included | b.png | uploaded by the user | turn 1 | 4×4]");
  // A tool's image is marked the same way; a hosted generation result cannot carry text and stays as it is.
  const tool = rewriteItems(input, describe, keys("IMG-002", "IMG-003"), noPixels).items;
  assert.deepEqual(texts(tool[5]), ["Script completed", "[图片 IMG-004 已提供｜a.png｜工具查看的图片｜第 1 轮｜4×4]", "input_image"]);
  assert.equal(tool[6], input[5]);
});

test("the explanation says a checked image comes back in its old place, marked, not in the user's new message", () => {
  assert.match(OMISSION_NOTE, /仍在提供的图片前面标着“\[图片 IMG-xxx 已提供…\]”/);
  assert.match(OMISSION_NOTE, /原图会回到它在对话里原来的位置/);
  assert.match(OMISSION_NOTE, /不会出现在用户的新消息里/);
  assert.match(OMISSION_NOTE, /标着“\[图片 IMG-xxx 已提供…\]”的图片现在就在你面前.*不要说看不到/);
  assert.match(omissionNote("en"), /each image still included is marked "\[Image IMG-xxx included…\]"/);
  assert.match(omissionNote("en"), /back in its old place in the conversation/);
  assert.match(omissionNote("en"), /does not come in the user's new message/);
  assert.match(omissionNote("en"), /marked "\[Image IMG-xxx included…\]" is in front of you now.*do not say you cannot see it/);
});

test("the explanation never splits a tool call from its output, and is left out when only copies are omitted", () => {
  const input = items();
  const { describe, keys } = index(input);
  // IMG-004 alone (with the red upload still sent) is a duplicate: its content stays in view, so no note.
  assert.equal(rewriteItems(input, describe, keys("IMG-004"), noPixels).report.noteAt, undefined);
  // The same view_image output without the upload before it: the note goes before that turn's user message.
  const toolOnly = [input[0], { type: "message", id: "msg_1", role: "user", content: [{ type: "input_text", text: "看看 a.png" }] }, input[3], input[4]];
  const tool = index(toolOnly);
  const { items: out, report } = rewriteItems(toolOnly, tool.describe, tool.keys("IMG-001"), noPixels);
  assert.equal(report.noteAt, 1);
  assert.deepEqual(out.map((item) => item.type), ["message", "message", "message", "custom_tool_call", "custom_tool_call_output"]);
});

test("an unchecked copy points at the identical image that is still sent, in either direction", () => {
  const input = items();
  const { describe, keys } = index(input);
  const later = rewriteItems(input, describe, keys("IMG-003"), noPixels);
  assert.match(texts(later.items[1])[9], /^\[图片 IMG-003（\[Image #3\]） 未重复提供｜b copy\.png｜用户上传｜第 1 轮｜4×4\]\n这张图和 IMG-002（b\.png，第 1 轮）内容完全相同/);
  assert.deepEqual(modes(later.report), [["IMG-003", "duplicate", "IMG-002"]]);
  assert.deepEqual(modes(rewriteItems(input, describe, keys("IMG-001"), noPixels).report), [["IMG-001", "duplicate", "IMG-004"]]);
});

test("when every copy is unchecked, each gets a plain placeholder", () => {
  const input = items();
  const { describe, keys } = index(input);
  assert.deepEqual(modes(rewriteItems(input, describe, keys("IMG-002", "IMG-003"), noPixels).report), [["IMG-002", "plain", null], ["IMG-003", "plain", null]]);
});

test("pixel-identical images with different bytes also count as the same content", () => {
  const input = items();
  const { describe, keys } = index(input);
  const redId = findImages(input)[0].contentId;
  const [blueKey] = keys("IMG-002");
  const pixels = (ref: ImageRef) => (ref.contentId === redId || ref.key === blueKey ? "same-pixels" : null);
  assert.deepEqual(modes(rewriteItems(input, describe, keys("IMG-002", "IMG-003", "IMG-004"), pixels).report), [
    ["IMG-002", "duplicate", "IMG-001"],
    ["IMG-003", "plain", null],
    ["IMG-004", "duplicate", "IMG-001"],
  ]);
});

test("tool-output images become text parts; hosted generation results stay and are reported as locked", () => {
  const input = items();
  const { describe, keys } = index(input);
  const { items: out, report } = rewriteItems(input, describe, keys("IMG-004", "IMG-005"), noPixels);
  assert.equal(texts(out[4])[0], "Script completed");
  assert.match(texts(out[4])[1], /^\[图片 IMG-004 未重复提供｜a\.png｜工具查看的图片｜第 1 轮｜4×4\]\n这张图和 IMG-001（a\.png，第 1 轮）/);
  assert.equal(out[5], input[5]);
  assert.deepEqual(report.locked, ["IMG-005"]);
});

test("the same selection always produces the same text", () => {
  const input = items();
  const { describe, keys } = index(input);
  const selected = keys("IMG-001", "IMG-003");
  assert.equal(JSON.stringify(rewriteItems(input, describe, selected, noPixels).items), JSON.stringify(rewriteItems(items(), describe, selected, noPixels).items));
});
