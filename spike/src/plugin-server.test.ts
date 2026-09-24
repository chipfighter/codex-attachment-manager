// Purpose: P3-3 — the plugin's MCP server: thread resolution, the rule that only the user may check or uncheck,
// thumbnails kept out of model-visible content, and a full stdio session (engine supervision switched off).
// Input: synthetic rollouts in temporary folders; output: Node test assertions only.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { callTool, fromModel, threadOf } from "./plugin-server.ts";
import { sampleSessions, THREAD } from "./testfixtures.ts";

const here = dirname(fileURLToPath(import.meta.url));
const modelMeta = { callId: "exec-1", "x-codex-turn-metadata": { thread_id: THREAD, turn_id: "t9" } };
const panelMeta = { thread_id: THREAD, threadId: THREAD, progressToken: 3 };

test("the thread comes from the arguments, the panel's meta, or the model's turn metadata", () => {
  assert.equal(threadOf({ threadId: "x" }, panelMeta), "x");
  assert.equal(threadOf({}, panelMeta), THREAD);
  assert.equal(threadOf({}, modelMeta), THREAD);
  assert.equal(threadOf({}, undefined), null);
  assert.equal(fromModel(modelMeta), true);
  assert.equal(fromModel(panelMeta), false);
});

test("the model can read the panel state but never change the selection", () => {
  const { sessionsDir, dataRoot } = sampleSessions();
  process.env.CAM_DATA_DIR = dataRoot;
  try {
    assert.equal(callTool("cam_panel_state", {}, modelMeta, sessionsDir).structuredContent.totals.images, 3);
    assert.throws(() => callTool("cam_set_selection", { uncheck: ["IMG-001"] }, modelMeta, sessionsDir), /只有用户能勾选或取消/);
    const done = callTool("cam_set_selection", { uncheck: ["IMG-001"] }, panelMeta, sessionsDir);
    assert.equal(done.structuredContent.totals.unchecked, 1);
  } finally {
    delete process.env.CAM_DATA_DIR;
  }
});

test("thumbnail data stays in _meta, out of the model-visible content", () => {
  const { sessionsDir, dataRoot } = sampleSessions();
  process.env.CAM_DATA_DIR = dataRoot;
  try {
    const result = callTool("cam_thumbnail", { id: "IMG-002" }, panelMeta, sessionsDir);
    assert.match(result._meta.dataUrl, /^data:image\/png;base64,/);
    assert.doesNotMatch(JSON.stringify(result.content) + JSON.stringify(result.structuredContent), /base64/);
  } finally {
    delete process.env.CAM_DATA_DIR;
  }
});

test("a stdio session lists the tools and answers calls", async () => {
  const { sessionsDir, dataRoot } = sampleSessions();
  const child = spawn(process.execPath, [join(here, "plugin-server.ts")], { env: { ...process.env, CAM_NO_ENGINE: "1", CAM_DATA_DIR: dataRoot, CODEX_HOME: dirname(sessionsDir) }, stdio: ["pipe", "pipe", "inherit"] });
  const replies: Record<number, any> = {};
  let buffer = "";
  child.stdout.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
      const message = JSON.parse(buffer.slice(0, end));
      replies[message.id] = message;
      buffer = buffer.slice(end + 1);
    }
  });
  const send = (message: object) => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  send({ id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test" } } });
  send({ method: "notifications/initialized" });
  send({ id: 2, method: "tools/list" });
  send({ id: 3, method: "tools/call", params: { name: "cam_panel_state", arguments: {}, _meta: panelMeta } });
  send({ id: 4, method: "tools/call", params: { name: "cam_set_selection", arguments: { uncheck: ["IMG-002"] }, _meta: modelMeta } });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("no replies")), 10_000);
    const check = setInterval(() => { if (replies[4]) { clearInterval(check); clearTimeout(timer); resolve(); } }, 20);
  });
  child.stdin.end();
  assert.deepEqual(replies[2].result.tools.map((tool: any) => tool.name), ["cam_panel_state", "cam_set_selection", "cam_thumbnail"]);
  assert.equal(replies[3].result.structuredContent.images.length, 3);
  assert.equal(replies[4].result.isError, true);
});
