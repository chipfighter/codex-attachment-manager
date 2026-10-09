// Purpose: v0.4 — the rewrite of a Claude Code request (claude-rewrite.ts): matching request images to the index,
// placeholders in user messages and inside tool results, "included" labels, the note as a system message right after
// the first omitted image's message, cache breakpoints kept, thinking untouched, automatic selection and copies.
// Input: synthetic transcripts and requests (claude-fixtures.ts); output: Node test assertions only.

import assert from "node:assert/strict";
import test from "node:test";
import { buildClaudeIndex } from "../../plugin/src/claude-index.ts";
import { findRequestImages, rewriteMessages } from "../../plugin/src/claude-rewrite.ts";
import { claudeNote } from "../../plugin/src/rewrite.ts";
import { image, pngA, pngB, pngC, text, transcript, usualRequest, usualSession } from "./claude-fixtures.ts";

const noPixels = () => null;

test("request images match the index: tool results by tool_use_id, pasted images by content and order", () => {
  const { t, p1, p3 } = usualSession();
  const index = buildClaudeIndex("s", t.records);
  const refs = findRequestImages(usualRequest(), index);
  assert.deepEqual(refs.map((ref) => [ref.msg, ref.part, ref.sub, ref.key]), [
    [0, 0, null, `${p1}#0`], [0, 1, null, `${p1}#1`], [4, 0, 0, "tool:toolu_1#0"], [6, 0, null, `${p3}#0`],
  ]);
});

test("a pasted image not in the transcript yet has no key; one matching no record is left alone", () => {
  const { t } = usualSession();
  const index = buildClaudeIndex("s", t.records);
  const messages = [...usualRequest().slice(0, 8), { role: "user", content: [image(pngB), text("new one")] }];
  assert.equal(findRequestImages(messages, index).at(-1)!.key, null);
});

test("records joined into one message still match, in order", () => {
  const t = transcript();
  const p1 = t.prompt([image(pngA), text("one")]);
  const p2 = t.prompt([image(pngB), text("two")]);
  const index = buildClaudeIndex("s", t.records);
  const refs = findRequestImages([{ role: "user", content: [image(pngA), text("one"), image(pngB), text("two")] }], index);
  assert.deepEqual(refs.map((ref) => ref.key), [`${p1}#0`, `${p2}#0`]);
});

test("after compaction, pasted images match the records after the boundary first", () => {
  const t = transcript();
  t.prompt([image(pngA), text("before")]);
  t.assistant(text("ok"));
  t.boundary();
  t.summary();
  const p2 = t.prompt([image(pngA), text("after")]);
  const index = buildClaudeIndex("s", t.records);
  const refs = findRequestImages([{ role: "user", content: [text("summary")] }, { role: "assistant", content: [text("ok")] }, { role: "user", content: [image(pngA), text("after")] }], index);
  assert.deepEqual(refs.map((ref) => ref.key), [`${p2}#0`]);
});

test("an unchecked pasted image becomes a placeholder; the note follows its message as a system message", () => {
  const { t, p1 } = usualSession();
  const index = buildClaudeIndex("s", t.records);
  const request = usualRequest();
  const before = JSON.stringify(request);
  const { messages, report } = rewriteMessages(request, index, new Set([`${p1}#1`]), noPixels, { lang: "zh" });
  assert.equal(JSON.stringify(request), before, "the input is not changed");
  assert.deepEqual(report.replaced.map((entry) => [entry.id, entry.mode]), [["IMG-002", "plain"]]);
  assert.equal(report.noteAt, 1);
  // Message 0: label + A, the placeholder in place of B, then the text as it was.
  assert.match(messages[0].content[0].text, /^\[图片 IMG-001 已提供｜未命名｜用户上传｜第 1 轮｜8×8\]$/);
  assert.equal(messages[0].content[1].source.data, pngA);
  assert.match(messages[0].content[2].text, /^\[图片 IMG-002 已省略｜未命名｜用户上传｜第 1 轮｜8×8\]\n.*需要 IMG-002/s);
  assert.equal(messages[0].content[3].text, "What are these?");
  assert.equal(messages[1].role, "system");
  assert.ok(messages[1].content.startsWith(claudeNote("zh")));
  assert.match(messages[1].content, /上面这条消息里的 IMG-002/);
  // The rest keeps its order; the thinking block and the cache breakpoint are untouched.
  assert.deepEqual(messages[2], request[1]);
  assert.equal(messages.length, request.length + 1);
  assert.deepEqual(messages.at(-1), request.at(-1));
  // Images still sent keep their labels: the tool result's and turn 3's.
  assert.match(messages[5].content[0].content[0].text, /IMG-003 已提供｜c\.png｜工具查看的图片/);
  assert.equal(messages[5].content[0].content[1].source.data, pngC);
  assert.match(messages[7].content[0].text, /IMG-004 已提供/);
});

test("an image in a tool result is replaced inside the result; a duplicate points to the copy still sent", () => {
  const { t, p1 } = usualSession();
  const index = buildClaudeIndex("s", t.records);
  const { messages, report } = rewriteMessages(usualRequest(), index, new Set(["tool:toolu_1#0", `${p1}#0`]), noPixels, { lang: "en" });
  assert.deepEqual(report.replaced.map((entry) => [entry.id, entry.mode, entry.sameAs]), [["IMG-001", "duplicate", "IMG-004"], ["IMG-003", "plain", null]]);
  const result = messages.find((message) => message.content?.[0]?.type === "tool_result")!.content[0];
  assert.equal(result.tool_use_id, "toolu_1");
  assert.equal(result.content.length, 1);
  assert.match(result.content[0].text, /^\[Image IMG-003 omitted \| c\.png \| viewed with a tool \| turn 2 \| 16×8\]/);
  // The note goes right after the tool result's message, the first with a plain placeholder.
  const at = messages.indexOf(messages.find((message) => message.content?.[0]?.type === "tool_result")!);
  assert.equal(messages[at + 1].role, "system");
  assert.equal(messages[at + 2].role, "assistant");
  assert.match(messages[0].content[0].text, /^\[Image IMG-001 not repeated/);
});

test("a placeholder keeps the cache breakpoint the image had; a system message already there takes the note", () => {
  const t = transcript();
  const p1 = t.prompt([image(pngA, { cache_control: { type: "ephemeral" } }), text("one")]);
  t.assistant(text("ok"));
  const index = buildClaudeIndex("s", t.records);
  const request = [
    { role: "user", content: [image(pngA, { cache_control: { type: "ephemeral" } }), text("one")] },
    { role: "system", content: "Claude Code's own" },
    { role: "assistant", content: [text("ok")] },
  ];
  const { messages } = rewriteMessages(request, index, new Set([`${p1}#0`]), noPixels, { lang: "zh" });
  assert.deepEqual(messages[0].content[0].cache_control, { type: "ephemeral" });
  assert.equal(messages.length, 3);
  assert.equal(messages[1].role, "system");
  assert.ok(messages[1].content[0].text.startsWith(claudeNote("zh")));
  assert.deepEqual(messages[1].content[1], { type: "text", text: "Claude Code's own" });
});

test("nothing to leave out: the same messages come back", () => {
  const { t } = usualSession();
  const index = buildClaudeIndex("s", t.records);
  const request = usualRequest();
  const { messages, report } = rewriteMessages(request, index, new Set(), noPixels);
  assert.equal(messages, request);
  assert.equal(report.replaced.length, 0);
  assert.equal(report.images, 4);
});

test("automatic selection: earlier turns' images out, this turn's in, only pinned earlier images labelled", () => {
  const { t, p1, p3 } = usualSession();
  const index = buildClaudeIndex("s", t.records);
  const leaveOut = new Set(index.images.filter((entry) => entry.turn! < 3 && entry.key !== `${p1}#1`).map((entry) => entry.key));
  const { messages, report } = rewriteMessages(usualRequest(), index, leaveOut, noPixels, { lang: "zh", auto: { currentTurn: 3 } });
  assert.deepEqual(report.replaced.map((entry) => entry.id), ["IMG-001", "IMG-003"]);
  assert.match(messages[0].content[0].text, /IMG-001 已省略[^]*cam_view_image/);
  // B (pinned, earlier turn) is labelled; turn 3's own image is not, so a fetch mid-turn changes nothing before it.
  assert.match(messages[0].content[1].text, /IMG-002 已提供/);
  const lastPaste = messages.find((message) => message.content?.some?.((block: any) => block.type === "text" && block.text === "Again?"));
  assert.equal(lastPaste.content[0].type, "image");
  assert.equal(messages[1].role, "system");
  assert.match(messages[1].content, /自动选图/);
  void p3;
});

test("a copy the model fetched in an earlier turn is left out, in either mode", () => {
  const t = transcript();
  t.prompt([image(pngA), text("look")]);
  t.assistant(text("red"));
  t.prompt("again");
  t.assistant({ type: "tool_use", id: "toolu_9", name: "mcp__x__cam_view_image", input: { ids: ["IMG-001"] } });
  t.toolResult("toolu_9", [text("[Image IMG-001 fetched original | unnamed | uploaded by the user | turn 1 | 8×8]"), image(pngA)]);
  t.assistant(text("still red"));
  t.prompt("third");
  const index = buildClaudeIndex("s", t.records);
  const request = [
    { role: "user", content: [image(pngA), text("look")] },
    { role: "assistant", content: [text("red")] },
    { role: "user", content: [text("again")] },
    { role: "assistant", content: [{ type: "tool_use", id: "toolu_9", name: "mcp__x__cam_view_image", input: { ids: ["IMG-001"] } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_9", content: [text("[Image IMG-001 fetched original | unnamed | uploaded by the user | turn 1 | 8×8]"), image(pngA)] }] },
    { role: "assistant", content: [text("still red")] },
    { role: "user", content: [text("third")] },
  ];
  const copies = new Map([...index.copies.values()].map((copy) => [copy.key, copy.of]));
  const { messages, report } = rewriteMessages(request, index, new Set(), noPixels, { lang: "en", copies });
  assert.deepEqual(report.copies, ["IMG-001"]);
  assert.equal(messages[4].content[0].content[1].text, "[Original of IMG-001: fetched by the model with cam_view_image, included only in that turn, now omitted]");
  // The original stays, labelled; no plain placeholder, so no note.
  assert.match(messages[0].content[0].text, /IMG-001 included/);
  assert.equal(report.noteAt, undefined);
});
