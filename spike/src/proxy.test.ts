// Purpose: P1-2/P2 — proxy helpers: outbound proxy detection, task identity, body metadata, and the request rewrite
// (placeholder swap, re-encoding, and the cases where the original bytes must be forwarded).
// Input: synthetic env, headers, request bodies and temporary rollouts; output: Node test assertions only.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import zlib from "node:zlib";
import { claudeIdentity, describeBody, forwardHeaders, hasUnchecked, hasUnsafeInteger, imageSizesOf, macProxy, needsRewrite, outboundProxy, redactImages, rewriteBody, requestIdentity, upstreamOf } from "../../plugin/src/proxy.ts";
import { writeSelection } from "../../plugin/src/selection.ts";
import { png } from "./testkit.ts";

// These tests check the Chinese wording: the language is fixed, so neither the system's language nor one a panel
// reported on this machine decides it (v0.1-14).
process.env.CAM_LANG = "zh";

const none = () => null;

test("outbound proxy comes from the environment, then Windows settings", () => {
  assert.deepEqual(outboundProxy({ HTTPS_PROXY: "http://127.0.0.1:8888", NO_PROXY: "localhost,127.0.0.1,::1,.local" }, none), { host: "127.0.0.1", port: 8888 });
  assert.deepEqual(outboundProxy({}, () => "http=10.0.0.1:80;https=10.0.0.2:8080"), { host: "10.0.0.2", port: 8080 });
  assert.deepEqual(outboundProxy({}, () => "127.0.0.1:7890"), { host: "127.0.0.1", port: 7890 });
  assert.equal(outboundProxy({}, none), null);
});

test("the macOS system proxy is read from scutil: HTTPS first, then HTTP, only when enabled", () => {
  const scutil = (lines: string[]) => `<dictionary> {\n  ExceptionsList : <array> {\n    0 : *.local\n  }\n${lines.map((line) => `  ${line}\n`).join("")}}\n`;
  assert.equal(macProxy(scutil(["HTTPEnable : 1", "HTTPPort : 8080", "HTTPProxy : 10.0.0.1", "HTTPSEnable : 1", "HTTPSPort : 7890", "HTTPSProxy : 127.0.0.1"])), "127.0.0.1:7890");
  assert.equal(macProxy(scutil(["HTTPEnable : 1", "HTTPPort : 8080", "HTTPProxy : 10.0.0.1", "HTTPSEnable : 0"])), "10.0.0.1:8080");
  assert.equal(macProxy(scutil(["HTTPSEnable : 0", "SOCKSEnable : 1", "SOCKSPort : 1080", "SOCKSProxy : 127.0.0.1"])), null);
  assert.deepEqual(outboundProxy({}, () => macProxy(scutil(["HTTPSEnable : 1", "HTTPSPort : 7890", "HTTPSProxy : 127.0.0.1"]))), { host: "127.0.0.1", port: 7890 });
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
  assert.match(text, /\[图片 IMG-001（\[Image #1\]） 已省略｜a\.png｜用户上传｜第 1 轮｜64×64]/);
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

// v0.3: automatic selection. The request belongs to turn 2, which the rollout has not recorded yet.
test("with automatic selection, rewriteBody leaves out earlier turns' images that are not pinned", () => {
  const { threadId, sessions, selections, red, blue, body } = fixture();
  assert.equal(needsRewrite(threadId, selections, sessions), false);
  writeSelection({ threadId, unchecked: {}, auto: true, autoAt: "2026-10-06T10:00:00Z", autoSince: "2026-10-06T10:00:00Z", pinned: { "msg_1#1": { id: "IMG-002", at: "2026-10-06T10:00:00Z" } } }, selections);
  assert.equal(needsRewrite(threadId, selections, sessions), true);
  const json = JSON.parse(zlib.zstdDecompressSync(body()).toString("utf8"));
  json.input.push({ type: "message", role: "user", content: [{ type: "input_text", text: "再看看" }] });
  const original = zlib.zstdCompressSync(Buffer.from(JSON.stringify(json)));
  const { body: out, report } = rewriteBody(original, "zstd", threadId, sessions, selections, "t2");
  const text = zlib.zstdDecompressSync(out).toString("utf8");
  assert.ok(!text.includes(red.slice(30)), "turn 1's IMG-001 is left out");
  assert.ok(text.includes(blue.slice(30)), "the pinned IMG-002 is still sent");
  assert.match(text, /\[图片 IMG-001（\[Image #1\]） 已省略｜a\.png｜用户上传｜第 1 轮｜64×64\]\\n之前各轮的图片默认省略/);
  assert.match(text, /\[图片 IMG-002（\[Image #2\]） 已提供｜b\.png/);
  assert.match(text, /上下文管理说明（来自用户安装的上下文素材管理工具）：这个任务开着“自动选图”/);
  assert.deepEqual([report.auto, report.replaced.map((r: Record<string, unknown>) => [r.id, r.mode])], [true, [["IMG-001", "plain"]]]);
  assert.equal(rewriteBody(original, "zstd", threadId, sessions, selections, "t1").body, original, "turn 1's own requests send its images");
});

// v0.4: Claude Code through the same engine.
test("Claude Code's /v1/ requests go to api.anthropic.com, everything else to chatgpt.com as before", () => {
  assert.equal(upstreamOf("/v1/messages"), "api.anthropic.com");
  assert.equal(upstreamOf("/v1/messages/count_tokens"), "api.anthropic.com");
  assert.equal(upstreamOf("/backend-api/codex/responses"), "chatgpt.com");
  assert.equal(upstreamOf("/backend-api/codex/images/generations"), "chatgpt.com");
  assert.equal(forwardHeaders({ host: "127.0.0.1:17891", "anthropic-beta": "oauth-2025-04-20", connection: "keep-alive" }, "api.anthropic.com").host, "api.anthropic.com");
  assert.equal(forwardHeaders({ authorization: "Bearer x" }, "api.anthropic.com").authorization, "Bearer x");
  assert.equal(forwardHeaders({ connection: "keep-alive" }, "api.anthropic.com").connection, undefined);
});

test("NO_PROXY is checked against each upstream host on its own", () => {
  const env = { HTTPS_PROXY: "http://127.0.0.1:8888", NO_PROXY: "chatgpt.com" };
  assert.equal(outboundProxy(env, none, "chatgpt.com"), null);
  assert.deepEqual(outboundProxy(env, none, "api.anthropic.com"), { host: "127.0.0.1", port: 8888 });
});

test("a Claude Code session and a subagent's loop are read from their headers", () => {
  assert.deepEqual(claudeIdentity({ "x-claude-code-session-id": "11111111-2222-4333-8444-555555555555" }), { sessionId: "11111111-2222-4333-8444-555555555555", agentId: null });
  assert.deepEqual(claudeIdentity({ "x-claude-code-session-id": "s", "x-claude-code-agent-id": "a1" }), { sessionId: "s", agentId: "a1" });
  assert.deepEqual(claudeIdentity({}), { sessionId: null, agentId: null });
});

test("Messages metadata counts images in user messages and tool results, and thinking blocks, without content", () => {
  const data = png(4, 4, () => [1, 2, 3]).toString("base64");
  const body = {
    model: "claude-haiku-5-5", stream: true, thinking: { type: "adaptive" },
    messages: [
      { role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data } }, { type: "text", text: "secret" }] },
      { role: "assistant", content: [{ type: "thinking", thinking: "", signature: "s" }, { type: "tool_use", id: "t", name: "Read", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data } }] }] },
    ],
  };
  const described = describeBody("/v1/messages", body);
  assert.deepEqual(described, { kind: "messages", model: "claude-haiku-5-5", messages: 3, images: 2, imageBytes: data.length * 2, thinkingBlocks: 1, thinking: "adaptive", stream: true });
  assert.ok(!JSON.stringify(described).includes("secret"));
  const redacted = JSON.stringify(redactImages({ ...body, messages: [{ role: "user", content: [{ type: "image", source: { type: "base64", data: "A".repeat(400) } }] }] }));
  assert.ok(!redacted.includes("A".repeat(300)));
  assert.match(redacted, /<sha256:[0-9a-f]{16} chars:400>/);
});

test("a Claude Code request is rewritten from the session's transcript and selection; nothing to do keeps the bytes", async () => {
  const { usualSession, usualRequest } = await import("./claude-fixtures.ts");
  const { claudeNeedsRewrite, rewriteClaudeBody, claudeImageSizes } = await import("../../plugin/src/proxy.ts");
  const { buildClaudeIndex } = await import("../../plugin/src/claude-index.ts");
  const home = mkdtempSync(join(tmpdir(), "cam-claude-home-"));
  const dir = mkdtempSync(join(tmpdir(), "cam-claude-sel-"));
  const session = "11111111-2222-4333-8444-555555555555";
  const { t, p1 } = usualSession();
  mkdirSync(join(home, "projects", "D--work"), { recursive: true });
  writeFileSync(join(home, "projects", "D--work", `${session}.jsonl`), t.records.map((record) => JSON.stringify(record)).join("\n") + "\n");
  const body = Buffer.from(JSON.stringify({ model: "claude-haiku-5-5", thinking: { type: "adaptive" }, messages: usualRequest() }));
  assert.equal(claudeNeedsRewrite(session, dir), false);
  assert.equal(rewriteClaudeBody(body, undefined, session, dir, home, {}).body, body);
  writeSelection({ threadId: session, unchecked: { [`${p1}#1`]: { id: "IMG-002", at: "2026-10-10T00:00:00Z" } } }, dir);
  assert.equal(claudeNeedsRewrite(session, dir), true);
  const out = rewriteClaudeBody(body, undefined, session, dir, home, {});
  assert.notEqual(out.body, body);
  assert.deepEqual(out.report.replaced.map((entry: any) => [entry.id, entry.mode]), [["IMG-002", "plain"]]);
  assert.equal(out.report.noteAt, 1);
  assert.equal(out.report.thinkingBlocks, 1);
  const json = JSON.parse(out.body.toString("utf8"));
  assert.equal(json.messages[1].role, "system");
  assert.deepEqual(json.thinking, { type: "adaptive" });
  // The experiment switch asks Anthropic to check the thinking, and names the beta header to add.
  const experiment = rewriteClaudeBody(body, undefined, session, dir, home, { CAM_EXPERIMENT_BLOCK_BINDING: "error" });
  assert.deepEqual(JSON.parse(experiment.body.toString("utf8")).thinking, { type: "adaptive", block_binding: { prefix_mismatch_behavior: "error" } });
  assert.equal(experiment.report.experiment.beta, "thinking-binding-controls-2026-08-01");
  // Image sizes by key, as the panel's baseline.
  const sizes = claudeImageSizes(usualRequest(), buildClaudeIndex(session, t.records));
  assert.deepEqual(Object.keys(sizes).length, 4);
});

test("Anthropic refusing the thinking after an edited history is told apart from other 400s", async () => {
  const { thinkingRejected } = await import("../../plugin/src/proxy.ts");
  const rejected = JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "messages.3.content.0: Invalid `signature` in `thinking` block. The block is bound to a different conversation." } });
  assert.equal(thinkingRejected(400, rejected), true);
  assert.equal(thinkingRejected(400, JSON.stringify({ error: { message: "max_tokens: too large" } })), false);
  assert.equal(thinkingRejected(500, rejected), false);
});
