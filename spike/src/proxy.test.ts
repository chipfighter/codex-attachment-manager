// Purpose: P1-2 — pure helpers of the transparent proxy: outbound proxy detection, task identity, body metadata.
// Input: synthetic env, headers and request bodies; output: Node test assertions only.

import assert from "node:assert/strict";
import test from "node:test";
import { describeBody, outboundProxy, requestIdentity } from "./proxy.ts";

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
