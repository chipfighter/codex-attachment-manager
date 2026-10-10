// Purpose: v0.4 — claude-thinking.ts: which thinking still fits after the engine changed the history before it, and
// the per-session record of what the engine sent. Input: synthetic message lists and a temporary folder; output: Node
// test assertions only.

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { chainOf, fitThinking, readThinkingRecord, rememberSent, writeThinkingRecord, type ThinkingRecord } from "../../plugin/src/claude-thinking.ts";

type Json = Record<string, any>;
const think = (signature: string) => ({ type: "thinking", thinking: "", signature });
const text = (value: string, extra: Json = {}) => ({ type: "text", text: value, ...extra });
const image = (data: string) => ({ type: "image", source: { type: "base64", media_type: "image/png", data } });
const user = (...content: Json[]) => ({ role: "user", content });
const assistant = (...content: Json[]) => ({ role: "assistant", content });

// Turn 1 shows an image; turns 1 and 2 think after it.
function session() {
  const m0 = user(image("AAAA"), text("What is it?"));
  const a1 = assistant(think("s1"), text("Red."));
  const m2 = user(text("And now?"));
  const a3 = assistant(think("s3"), text("Still red."));
  const m4 = user(text("Next."));
  return { m0, a1, m2, a3, m4, original: [m0, a1, m2, a3, m4] };
}
// The engine's edit: the image becomes a placeholder, and a note follows its message.
const omitted = (m0: Json) => [user(text("[IMG-001 omitted]"), m0.content[1]), { role: "system", content: "note" }];

test("nothing changed: every thinking block stays, and what is sent is the history", () => {
  const { original } = session();
  const fit = fitThinking(original, original, new Map());
  assert.deepEqual([fit.kept, fit.left], [2, 0]);
  assert.deepEqual(fit.messages, original);
  assert.equal(fit.sent, fit.history);
});

test("thinking made after the history as it was leaves once an image before it is left out", () => {
  const s = session();
  const fit = fitThinking(s.original, [...omitted(s.m0), s.a1, s.m2, s.a3, s.m4], new Map());
  assert.deepEqual([fit.kept, fit.left], [0, 2]);
  assert.deepEqual(fit.messages[2].content, [text("Red.")]);
  assert.deepEqual(fit.messages[4].content, [text("Still red.")]);
  assert.notEqual(fit.sent, fit.history);
});

test("thinking made after what the engine sent stays, as long as the same goes out before it", () => {
  const s = session();
  // The request of turn 2: the image already left out, s1 with it.
  const before = fitThinking([s.m0, s.a1, s.m2], [...omitted(s.m0), s.a1, s.m2], new Map());
  assert.equal(before.left, 1);
  const record: ThinkingRecord = { strict: true, sent: new Map() };
  rememberSent(record, before.history, before.sent);
  // Turn 3: s3 was made after what turn 2 sent.
  const fit = fitThinking(s.original, [...omitted(s.m0), s.a1, s.m2, s.a3, s.m4], record.sent);
  assert.deepEqual([fit.kept, fit.left], [1, 1]);
  assert.deepEqual(fit.messages[4], s.a3);
  // The image checked again: s1 fits again; s3 was made while the image was left out, so it does not.
  const back = fitThinking(s.original, s.original, record.sent);
  assert.deepEqual([back.kept, back.left], [1, 1]);
  assert.deepEqual(back.messages[1], s.a1);
  assert.deepEqual(back.messages[3].content, [text("Still red.")]);
});

test("an edit after a thinking block leaves that block alone", () => {
  const s = session();
  const m2 = user(text("And now?"), image("BBBB"));
  const fit = fitThinking([s.m0, s.a1, m2, s.a3], [s.m0, s.a1, user(text("And now?"), text("[IMG-002 omitted]")), { role: "system", content: "note" }, s.a3], new Map());
  assert.deepEqual([fit.kept, fit.left], [1, 1]);
  assert.deepEqual(fit.messages[1], s.a1);
});

test("cache breakpoints, key order and string content are not part of the history; a message of thinking alone is not emptied", () => {
  const s = session();
  const moved = [s.m0, s.a1, s.m2, s.a3, user(text("Next.", { cache_control: { type: "ephemeral" } }))];
  assert.equal(chainOf(moved), chainOf(s.original));
  // Claude Code 2.1.295: its trailing system message is a block with a breakpoint while it is last, a string after.
  const last = { role: "system", content: [text("<total_tokens>1 tokens left</total_tokens>", { cache_control: { type: "ephemeral" } })] };
  const later = { content: "<total_tokens>1 tokens left</total_tokens>", role: "system" };
  assert.equal(chainOf([s.m0, last]), chainOf([s.m0, later]));
  const result = (content: unknown) => user({ type: "tool_result", tool_use_id: "toolu_1", content });
  assert.equal(chainOf([result("done")]), chainOf([result([{ type: "text", text: "done" }])]));
  assert.notEqual(chainOf([s.m0, later]), chainOf([s.m0, { ...later, content: "<total_tokens>2 tokens left</total_tokens>" }]));
  const alone = assistant(think("s9"));
  const fit = fitThinking([s.m0, alone], [...omitted(s.m0), alone], new Map());
  assert.deepEqual([fit.kept, fit.left], [1, 0]);
});

test("the record: what was sent per history, kept per session id, latest entries only", () => {
  const dir = mkdtempSync(join(tmpdir(), "cam-thinking-"));
  const id = "11111111-2222-4333-8444-555555555555";
  const record = readThinkingRecord(id, dir);
  assert.deepEqual(record, { strict: false, sent: new Map() });
  record.strict = true;
  rememberSent(record, "h1", "s1");
  // A history sent as it was needs no entry, and drops an older one.
  rememberSent(record, "h2", "s2");
  rememberSent(record, "h2", "h2");
  writeThinkingRecord(id, record, dir);
  assert.deepEqual(readThinkingRecord(id, dir), { strict: true, sent: new Map([["h1", "s1"]]) });
  writeThinkingRecord("../elsewhere", record, dir);
  assert.equal(readThinkingRecord("../elsewhere", dir).strict, false);
  for (let i = 0; i < 2100; i++) rememberSent(record, `k${i}`, `v${i}`);
  assert.equal(record.sent.size, 2000);
  assert.equal(record.sent.has("h1"), false);
  assert.equal(record.sent.get("k2099"), "v2099");
});
