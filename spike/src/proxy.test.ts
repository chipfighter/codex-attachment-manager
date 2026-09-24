// Purpose: P1-2/P2 — proxy helpers: outbound proxy detection, task identity, body metadata, and the request rewrite
// (placeholder swap, re-encoding, and the cases where the original bytes must be forwarded).
// Input: synthetic env, headers, request bodies and temporary rollouts; output: Node test assertions only.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import zlib from "node:zlib";
import { describeBody, hasUnchecked, hasUnsafeInteger, imageSizesOf, outboundProxy, rewriteBody, requestIdentity } from "./proxy.ts";
import { writeSelection } from "./selection.ts";
import { png } from "./testkit.ts";

const none = () => null;

test("outbound proxy comes from the environment, then Windows settings", () => {
  assert.deepEqual(outboundProxy({ HTTPS_PROXY: "http://127.0.0.1:8888", NO_PROXY: "localhost,127.0.0.1,::1,.local" }, none), { host: "127.0.0.1", port: 8888 });
  assert.deepEqual(outboundProxy({}, () => "http=10.0.0.1:80;https=10.0.0.2:8080"), { host: "10.0.0.2", port: 8080 });
  assert.deepEqual(outboundProxy({}, () => "127.0.0.1:7890"), { host: "127.0.0.1", port: 7890 });
  assert.equal(outboundProxy({}, none), null);
});

test("NO_PROXY entries covering the upstream host mean a direct connection", () => {
  for (const entry of ["chatgpt.com", ".chatgpt.com", "*"]) {
    assert.equal(outboundProxy({ HTTPS_PROXY: "http://127.0.0.1:8888", NO_PROXY: `localhost,${entry}` }, none), null);
  }
});

test("the task a request belongs to is read from x-codex-turn-metadata", () => {
  const headers = { "x-codex-turn-metadata": JSON.stringify({ thread_id: "thread-a", turn_id: "turn-1" }), "x-codex-window-id": "thread-a:0" };
  assert.deepEqual(requestIdentity(headers), { threadId: "thread-a", turnId: "turn-1", windowId: "thread-a:0" });
  assert.deepEqual(requestIdentity({ "x-codex-turn-metadata": "not json" }), { threadId: null, turnId: null, windowId: null });
});

test("request metadata counts images in messages and in tool outputs, without content", () => {
  const body = {
    model: "m",
    prompt_cache_key: "thread-a",
    stream: true,
    input: [
      { type: "message", role: "user", content: [{ type: "input_text", text: "secret words" }, { type: "input_image", image_url: "data:image/png;base64,AAAA" }] },
      { type: "custom_tool_call_output", call_id: "c1", output: [{ type: "input_image", image_url: "data:image/png;base64,BBBBBBBB" }] },
    ],
  };
  const described = describeBody("/backend-api/codex/responses", body);
  assert.deepEqual(described, { kind: "responses", model: "m", inputItems: 2, images: 2, imageBytes: "data:image/png;base64,AAAA".length + "data:image/png;base64,BBBBBBBB".length, stream: true, promptCacheKey: "thread-a" });
  assert.doesNotMatch(JSON.stringify(described), /secret words/);
  assert.equal(describeBody("/backend-api/codex/images/edits", { model: "gpt-image", images: [{}, {}], size: "1024x1024" }).kind, "image_edit");
});

test("the size baseline names each image by its index key, with its base64 length and nothing else", () => {
  const input = [
    { type: "message", id: "msg_1", role: "user", content: [{ type: "input_text", text: "secret words" }, { type: "input_image", image_url: "data:image/png;base64,AAAA" }] },
    { type: "custom_tool_call_output", call_id: "c1", output: [{ type: "input_image", image_url: "data:image/png;base64,BBBBBBBB" }] },
  ];
  assert.deepEqual(imageSizesOf(input), { "msg_1#0": 4, "custom_tool_call_output:c1#0": 8 });
});

test("integers JavaScript cannot hold exactly are detected outside strings only", () => {
  assert.equal(hasUnsafeInteger('{"a":12345678901234567}'), true);
  assert.equal(hasUnsafeInteger('{"a":"order 12345678901234567","b":1790246521.5642291234567,"c":[1,-2,3e25]}'), false);
  assert.equal(hasUnsafeInteger('{"a":9007199254740991}'), false);
});

// P2: a zstd request for a thread whose rollout and selection live in temporary directories.
function fixture() {
  const threadId = "01a0d301-0000-7000-8000-00000000000c";
  const root = mkdtempSync(join(tmpdir(), "cam-proxy-"));
  const sessions = join(root, "sessions");
  const selections = join(root, "selection");
  mkdirSync(join(sessions, "2026", "09", "24"), { recursive: true });
  // A noisy 64×64 image, large enough that its placeholder is smaller than the image itself.
  const red = `data:image/png;base64,${png(64, 64, (x, y) => [255, (x * 37 + y * 101) % 256, (x * y) % 256]).toString("base64")}`;
  const blue = `data:image/png;base64,${png(8, 8, () => [0, 0, 255]).toString("base64")}`;
  const message = {
    type: "message", id: "msg_1", role: "user",
    content: [
      { type: "input_text", text: "两张图" },
      { type: "input_text", text: String.raw`<image name=[Image #1] path="C:\w\a.png">` }, { type: "input_image", image_url: red }, { type: "input_text", text: "</image>" },
      { type: "input_text", text: String.raw`<image name=[Image #2] path="C:\w\b.png">` }, { type: "input_image", image_url: blue }, { type: "input_text", text: "</image>" },
    ],
    internal_chat_message_metadata_passthrough: { turn_id: "t1" },
  };
  const rollout = [{ type: "session_meta", payload: { id: threadId } }, { type: "event_msg", payload: { type: "task_started", turn_id: "t1" } }, { type: "response_item", payload: message }];
  writeFileSync(join(sessions, "2026", "09", "24", `rollout-2026-09-24T10-00-00-${threadId}.jsonl`), rollout.map((r) => JSON.stringify(r)).join("\n") + "\n");
  const body = (extra = "") => zlib.zstdCompressSync(Buffer.from(`{"model":"m","input":[${JSON.stringify(message)}],"stream":true${extra}}`));
  return { threadId, sessions, selections, red, blue, body };
}

test("rewriteBody swaps the unchecked image for a placeholder and re-encodes the body", () => {
  const { threadId, sessions, selections, red, blue, body } = fixture();
  assert.equal(hasUnchecked(threadId, selections), false);
  writeSelection({ threadId, unchecked: { "msg_1#0": { id: "IMG-001", at: "2026-09-24T10:00:00Z" } } }, selections);
  assert.equal(hasUnchecked(threadId, selections), true);
  const original = body();
  const { body: out, report } = rewriteBody(original, "zstd", threadId, sessions, selections);
  const text = zlib.zstdDecompressSync(out).toString("utf8");
  assert.ok(!text.includes(red.slice(30)), "the unchecked image is gone");
  assert.ok(text.includes(blue.slice(30)), "the checked image is still there");
  assert.match(text, /\[图片 IMG-001（\[Image #1\]） 未提供｜a\.png｜用户上传｜第 1 轮｜64×64]/);
  assert.deepEqual(report.replaced, [{ id: "IMG-001", kind: "upload", mode: "plain", sameAs: null, base64Chars: red.length - "data:image/png;base64,".length }]);
  assert.ok(report.decodedAfter < report.decodedBefore);
  assert.equal(text, JSON.stringify(JSON.parse(text)), "re-serialized as compact JSON, like Codex's own bodies");
});

test("rewriteBody forwards the original bytes when nothing applies or the body is not safe to re-serialize", () => {
  const { threadId, sessions, selections, body } = fixture();
  writeSelection({ threadId, unchecked: { "msg_other#0": { id: "IMG-009", at: "2026-09-24T10:00:00Z" } } }, selections);
  const original = body();
  assert.equal(rewriteBody(original, "zstd", threadId, sessions, selections).body, original);
  writeSelection({ threadId, unchecked: { "msg_1#0": { id: "IMG-001", at: "2026-09-24T10:00:00Z" } } }, selections);
  const risky = body(',"big":12345678901234567');
  const { body: out, report } = rewriteBody(risky, "zstd", threadId, sessions, selections);
  assert.equal(out, risky);
  assert.match(report.skipped, /2\^53/);
});
