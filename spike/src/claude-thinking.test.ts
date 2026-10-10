// Purpose: v0.4 — claude-thinking.ts: which thinking still fits after the engine changed the history before it, and
// the per-session record of what the engine sent. Input: synthetic message lists and a temporary folder; output: Node
// test assertions only.

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { chainOf, fitThinking, newThinkingRecord, readThinkingRecord, recordSent, rememberSent, writeThinkingRecord } from "../../plugin/src/claude-thinking.ts";

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

test("before the engine changed anything, every thinking block fits the history as it is", () => {
  const { original } = session();
  const fit = fitThinking(original, original, newThinkingRecord());
  assert.deepEqual([fit.kept, fit.left], [2, 0]);
  assert.deepEqual(fit.messages, original);
  assert.equal(fit.sent, fit.history);
  assert.equal(fit.made.length, 2);
});

test("thinking made after the history as it was leaves once an image before it is left out", () => {
  const s = session();
  const fit = fitThinking(s.original, [...omitted(s.m0), s.a1, s.m2, s.a3, s.m4], newThinkingRecord());
  assert.deepEqual([fit.kept, fit.left], [0, 2]);
  assert.deepEqual(fit.messages[2].content, [text("Red.")]);
  assert.deepEqual(fit.messages[4].content, [text("Still red.")]);
  assert.notEqual(fit.sent, fit.history);
});

test("thinking made after what the engine sent stays, as long as the same goes out before it", () => {
  const s = session();
  const record = newThinkingRecord();
  // The request of turn 2: the image already left out, s1 with it.
  const before = fitThinking([s.m0, s.a1, s.m2], [...omitted(s.m0), s.a1, s.m2], record);
  assert.equal(before.left, 1);
  assert.equal(recordSent(record, before.history, before.sent, before.made), true);
  assert.equal(record.edited, true);
  // Turn 3: s3 was made after what turn 2 sent.
  const fit = fitThinking(s.original, [...omitted(s.m0), s.a1, s.m2, s.a3, s.m4], record);
  assert.deepEqual([fit.kept, fit.left], [1, 1]);
  assert.deepEqual(fit.messages[4], s.a3);
  // The image checked again: s1 was made before anything changed, so it fits again; s3 was made while the image was
  // left out, so it does not.
  const back = fitThinking(s.original, s.original, record);
  assert.deepEqual([back.kept, back.left], [1, 1]);
  assert.deepEqual(back.messages[1], s.a1);
  assert.deepEqual(back.messages[3].content, [text("Still red.")]);
});

test("once the engine changed a history, thinking after one it has no entry for is left out", () => {
  const s = session();
  // A record that lost its entries (a deleted file, old entries): nothing is known about what went out.
  const fit = fitThinking(s.original, s.original, { edited: true, strict: true, sent: new Map() });
  assert.deepEqual([fit.kept, fit.left], [0, 2]);
});

test("an edit after a thinking block leaves that block alone", () => {
  const s = session();
  const m2 = user(text("And now?"), image("BBBB"));
  const fit = fitThinking([s.m0, s.a1, m2, s.a3], [s.m0, s.a1, user(text("And now?"), text("[IMG-002 omitted]")), { role: "system", content: "note" }, s.a3], newThinkingRecord());
  assert.deepEqual([fit.kept, fit.left], [1, 1]);
  assert.deepEqual(fit.messages[1], s.a1);
});

test("without any thinking: every block goes, and a message of thinking alone goes with it", () => {
  const s = session();
  const alone = assistant(think("s9"));
  const bare = fitThinking([...s.original, alone], [...s.original, alone], newThinkingRecord(), false);
  assert.deepEqual([bare.kept, bare.left], [0, 3]);
  assert.equal(bare.messages.length, s.original.length);
  assert.deepEqual(bare.messages[1].content, [text("Red.")]);
  // Left out because it no longer fits, too.
  const fit = fitThinking([s.m0, alone], [...omitted(s.m0), alone], newThinkingRecord());
  assert.deepEqual([fit.kept, fit.left, fit.messages.length], [0, 1, 2]);
});

test("cache breakpoints, key order and string content are not part of the history", () => {
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
});

test("the record: started by the first changed history, kept per session id, latest entries only", () => {
  const dir = mkdtempSync(join(tmpdir(), "cam-thinking-"));
  const id = "11111111-2222-4333-8444-555555555555";
  const record = readThinkingRecord(id, dir);
  assert.deepEqual(record, newThinkingRecord());
  // A history sent as it was, before anything changed: nothing to remember.
  assert.equal(recordSent(record, "h0", "h0", []), false);
  assert.equal(record.edited, false);
  // The first changed one: with the histories the thinking so far was made after.
  assert.equal(recordSent(record, "h1", "s1", ["h0"]), true);
  assert.deepEqual([...record.sent], [["h0", "h0"], ["h1", "s1"]]);
  // From then on, histories sent as they were are remembered too.
  recordSent(record, "h2", "h2", []);
  record.strict = true;
  writeThinkingRecord(id, record, dir);
  assert.deepEqual(readThinkingRecord(id, dir), { edited: true, strict: true, sent: new Map([["h0", "h0"], ["h1", "s1"], ["h2", "h2"]]) });
  writeThinkingRecord("../elsewhere", record, dir);
  assert.deepEqual(readThinkingRecord("../elsewhere", dir), newThinkingRecord());
  // An unreadable record: what went out is unknown.
  writeFileSync(join(dir, `${id}.json`), "{");
  assert.deepEqual(readThinkingRecord(id, dir), { edited: true, strict: false, sent: new Map() });
  for (let i = 0; i < 2100; i++) rememberSent(record, `k${i}`, `v${i}`);
  assert.equal(record.sent.size, 2000);
  assert.equal(record.sent.has("h1"), false);
  assert.equal(record.sent.get("k2099"), "v2099");
});
