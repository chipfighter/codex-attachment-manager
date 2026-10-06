// Purpose: P3-3 — the plugin's MCP server: thread resolution, the rule that only the user may check or uncheck,
// thumbnails kept out of model-visible content, and a full stdio session (engine supervision switched off).
// P4 — the panel's entrypoint and page resource. v0.1-10 — a panel on a new chat is offered the thread the user just
// started and follows it once bound. v0.3 — cam_view_image, the model's one tool, works only with automatic selection.
// Input: synthetic rollouts in temporary folders; output: Node test assertions only.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { callTool, fromModel, PANEL_MIME, PANEL_URI, readResource, threadOf, TOOLS } from "../../plugin/src/plugin-server.ts";
import { writeSelection } from "../../plugin/src/selection.ts";
import { line, red, sampleSessions, startThread, THREAD, turn, upload } from "./testfixtures.ts";

// These tests check the Chinese wording: the language is fixed, so neither the system's language nor one a panel
// reported on this machine decides it (v0.1-14).
process.env.CAM_LANG = "zh";

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

test("the panel is a thread entrypoint with a fixed page; only the entry tool renders it", () => {
  const panel = TOOLS.find((tool) => tool.name === "cam_panel")!;
  assert.deepEqual(panel._meta, { ui: { resourceUri: PANEL_URI, visibility: ["app"] }, "openai/ui": { entrypoints: [{ type: "thread" }] } });
  for (const tool of TOOLS.filter((tool) => tool.name !== "cam_view_image")) assert.deepEqual(tool._meta?.ui.visibility, ["app"], `${tool.name} is for the panel, not the model`);
  // v0.3: the one tool for the model, which only reads.
  const fetch = TOOLS.find((tool) => tool.name === "cam_view_image")!;
  assert.equal(fetch._meta, undefined);
  assert.deepEqual(fetch.annotations, { readOnlyHint: true });
  const [page] = readResource(PANEL_URI).contents;
  assert.equal(page.mimeType, PANEL_MIME);
  assert.match(page.text, /<title>上下文素材<\/title>/);
  assert.doesNotMatch(page.text, /https?:\/\/(?!www\.w3\.org)/, "the page loads nothing from the network");
  assert.throws(() => readResource("ui://codex-attachment-manager/other.html"), /unknown resource/);
});

test("the model can read the panel state but never change the selection", () => {
  const { sessionsDir, dataRoot } = sampleSessions();
  process.env.CAM_DATA_DIR = dataRoot;
  try {
    assert.equal(callTool("cam_panel", {}, modelMeta, sessionsDir).structuredContent.totals.images, 3);
    assert.throws(() => callTool("cam_set_selection", { uncheck: ["IMG-001"] }, modelMeta, sessionsDir), /只有用户能勾选或取消/);
    const done = callTool("cam_set_selection", { uncheck: ["IMG-001"] }, panelMeta, sessionsDir);
    assert.equal(done.structuredContent.totals.unchecked, 1);
  } finally {
    delete process.env.CAM_DATA_DIR;
  }
});

test("image data stays in _meta, out of the model-visible content", () => {
  const { sessionsDir, dataRoot } = sampleSessions();
  process.env.CAM_DATA_DIR = dataRoot;
  try {
    const result = callTool("cam_image", { id: "IMG-002" }, panelMeta, sessionsDir);
    assert.match(result._meta.dataUrl, /^data:image\/png;base64,/);
    assert.doesNotMatch(JSON.stringify(result.content) + JSON.stringify(result.structuredContent), /base64/);
  } finally {
    delete process.env.CAM_DATA_DIR;
  }
});

test("the model fetches originals by id only where automatic selection is on (v0.3)", () => {
  const { sessionsDir, dataRoot } = sampleSessions();
  process.env.CAM_DATA_DIR = dataRoot;
  try {
    const off = callTool("cam_view_image", { ids: ["IMG-001"] }, modelMeta, sessionsDir);
    assert.equal(off.isError, true);
    assert.match(off.content[0].text, /没有开自动选图.*需要 IMG-xxx/);
    writeSelection({ threadId: THREAD, unchecked: {}, auto: true, autoAt: "2026-10-06T10:00:00Z", autoSince: "2026-10-06T10:00:00Z" }, join(dataRoot, "selection"));
    const on = callTool("cam_view_image", { ids: ["img-001", "IMG-009"] }, modelMeta, sessionsDir);
    assert.equal(on.isError, false);
    assert.deepEqual(on.content.map((part: any) => part.type), ["text", "image", "text"]);
    // The line before the image names it (no "[Image #1]"), so the index knows the image as a copy of IMG-001.
    assert.equal(on.content[0].text, "[图片 IMG-001 取回的原图｜a.png｜用户上传｜第 1 轮｜64×32]");
    assert.equal(on.content[1].mimeType, "image/png");
    assert.equal(Buffer.from(on.content[1].data, "base64").equals(red), true, "the original bytes, not a thumbnail");
    assert.match(on.content[2].text, /没有 IMG-009/);
    assert.equal(callTool("cam_view_image", { ids: ["IMG-009"] }, modelMeta, sessionsDir).isError, true);
  } finally {
    delete process.env.CAM_DATA_DIR;
  }
});

test("a stdio session lists the tools and answers calls", async () => {
  const { sessionsDir, dataRoot } = sampleSessions();
  const child = spawn(process.execPath, [join(here, "..", "..", "plugin", "src", "plugin-server.ts")], { env: { ...process.env, CAM_NO_ENGINE: "1", CAM_DATA_DIR: dataRoot, CODEX_HOME: dirname(sessionsDir) }, stdio: ["pipe", "pipe", "inherit"] });
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
  send({ id: 3, method: "tools/call", params: { name: "cam_panel", arguments: {}, _meta: panelMeta } });
  send({ id: 4, method: "tools/call", params: { name: "cam_set_selection", arguments: { uncheck: ["IMG-002"] }, _meta: modelMeta } });
  send({ id: 5, method: "resources/list" });
  send({ id: 6, method: "resources/read", params: { uri: PANEL_URI } });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("no replies")), 10_000);
    const check = setInterval(() => { if (replies[6]) { clearInterval(check); clearTimeout(timer); resolve(); } }, 20);
  });
  child.stdin.end();
  assert.deepEqual(replies[1].result.capabilities, { tools: {}, resources: {} });
  assert.deepEqual(replies[1].result.serverInfo.icons.map((icon: any) => [icon.theme, icon.src.slice(0, 26)]), [["light", "data:image/svg+xml;base64,"], ["dark", "data:image/svg+xml;base64,"]]);
  assert.deepEqual(replies[2].result.tools.map((tool: any) => tool.name), ["cam_panel", "cam_set_selection", "cam_image", "cam_setup", "cam_bind", "cam_view_image"]);
  assert.equal(replies[3].result.structuredContent.images.length, 3);
  assert.equal(replies[3].result.structuredContent.engineRunning, null, "engine supervision is off in this test");
  assert.equal(replies[4].result.isError, true);
  assert.deepEqual(replies[5].result.resources.map((resource: any) => [resource.uri, resource.mimeType]), [[PANEL_URI, PANEL_MIME]]);
  assert.equal(replies[6].result.contents[0].mimeType, PANEL_MIME);
});

test("a panel on a new chat is offered the thread the user just started, and follows it once bound", () => {
  const { sessionsDir, dataRoot } = sampleSessions();
  process.env.CAM_DATA_DIR = dataRoot;
  const PANEL = "01a0d301-0000-7000-8000-00000000f00d";
  const NEW = "01a0d301-0000-7000-8000-0000000000d1";
  const SUB = "01a0d301-0000-7000-8000-0000000000d2";
  const meta = { thread_id: PANEL, threadId: PANEL };
  try {
    const shown = [[Date.now() - 5_000, Date.now()]];
    assert.deepEqual(callTool("cam_panel", { shown }, meta, sessionsDir).structuredContent.newTasks, []);
    startThread(sessionsDir, NEW, {}, 1_000, line("event_msg", { type: "user_message", message: "看看这张图" }) + turn("t1") + upload("msg_n", "t1", [["n.png", red]]));
    startThread(sessionsDir, SUB, { source: { subagent: { thread_spawn: { parent_thread_id: NEW, depth: 1 } } }, thread_source: "subagent", parent_thread_id: NEW }, 500);
    const waiting = callTool("cam_panel", { shown }, meta, sessionsDir).structuredContent;
    assert.equal(waiting.started, false);
    assert.deepEqual(waiting.newTasks.map((task: any) => [task.threadId, task.title]), [[NEW, "看看这张图"]], "the sub-agent is not offered");
    assert.equal(callTool("cam_panel", {}, meta, sessionsDir).structuredContent.newTasks, undefined, "Codex's own call gets no list");
    assert.throws(() => callTool("cam_bind", { target: NEW }, { ...meta, "x-codex-turn-metadata": { thread_id: PANEL } }, sessionsDir), /只有用户能切换/);
    assert.throws(() => callTool("cam_bind", { target: SUB }, meta, sessionsDir), /只能切到用户自己开始的任务/);
    const bound = callTool("cam_bind", { target: NEW }, meta, sessionsDir).structuredContent;
    assert.deepEqual([bound.threadId, bound.switchedFrom, bound.images.length, bound.title], [NEW, PANEL, 1, "看看这张图"]);
    const later = callTool("cam_panel", { shown }, meta, sessionsDir).structuredContent;
    assert.deepEqual([later.threadId, later.switchedFrom, later.newTasks], [NEW, PANEL, undefined]);
    callTool("cam_set_selection", { uncheck: ["IMG-001"] }, meta, sessionsDir);
    assert.equal(callTool("cam_panel", {}, { thread_id: NEW, threadId: NEW }, sessionsDir).structuredContent.totals.unchecked, 1, "the change is the new thread's");
    assert.throws(() => callTool("cam_bind", { target: NEW }, panelMeta, sessionsDir), /已经开始/, "a panel on a started thread stays");
  } finally {
    delete process.env.CAM_DATA_DIR;
  }
});
