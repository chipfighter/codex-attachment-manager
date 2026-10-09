// Purpose: v0.4 — the Claude panel's data: the engine's local panel API (claudePanelApi in proxy.ts) for a session's
// images, checking and unchecking, images for thumbnails and automatic selection; and the plugin service's
// cam_view_image under Claude Code (callClaudeTool in plugin-server.ts). All from the session's transcript and the
// selection kept for Claude sessions.
// Input: a synthetic transcript under a temporary Claude config dir and a temporary data dir; output: assertions only.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { claudeSelectionDirOf } from "../../plugin/src/paths.ts";
import { callClaudeTool, claudeToolsFor } from "../../plugin/src/plugin-server.ts";
import { claudePanelApi } from "../../plugin/src/proxy.ts";
import { pngC, usualSession } from "./claude-fixtures.ts";

process.env.CAM_LANG = "zh";
const session = "11111111-2222-4333-8444-555555555555";
const panelHeaders = { "x-cam-panel": "1" };

function setup() {
  const home = mkdtempSync(join(tmpdir(), "cam-claude-home-"));
  const dataRoot = mkdtempSync(join(tmpdir(), "cam-claude-data-"));
  const { t, p1 } = usualSession();
  mkdirSync(join(home, "projects", "D--work"), { recursive: true });
  writeFileSync(join(home, "projects", "D--work", `${session}.jsonl`), t.records.map((record) => JSON.stringify(record)).join("\n") + "\n");
  return { options: { home, dataRoot }, p1 };
}
const get = (path: string, options: object) => claudePanelApi("GET", path, panelHeaders, "", options);
const post = (path: string, change: object, options: object) => claudePanelApi("POST", path, panelHeaders, JSON.stringify(change), options);

test("under Claude Code only the fetch tool is listed for the model", () => {
  assert.deepEqual(claudeToolsFor("zh").map((tool) => tool.name), ["cam_view_image"]);
});

test("the panel API answers only the panel: our header, no browser Origin, a session id", () => {
  const { options } = setup();
  assert.equal(claudePanelApi("GET", `/__cam/claude/panel?session=${session}`, {}, "", options).status, 403);
  assert.equal(claudePanelApi("GET", `/__cam/claude/panel?session=${session}`, { ...panelHeaders, origin: "https://example.com" }, "", options).status, 403);
  assert.equal(get("/__cam/claude/panel?session=nope", options).status, 400);
  assert.equal(get(`/__cam/claude/other?session=${session}`, options).status, 404);
  assert.equal(claudePanelApi("POST", `/__cam/claude/select?session=${session}`, panelHeaders, null, options).status, 413);
});

test("the panel's data for a session: images, turns, title, the language", () => {
  const { options } = setup();
  const { status, body } = get(`/__cam/claude/panel?session=${session}`, options);
  assert.equal(status, 200);
  assert.deepEqual(body.images.map((image: any) => [image.id, image.kind, image.turn, image.checked]), [["IMG-001", "upload", 1, true], ["IMG-002", "upload", 1, true], ["IMG-003", "view", 2, true], ["IMG-004", "upload", 3, true]]);
  assert.equal(body.title, "What are these?");
  assert.equal(body.started, true);
  assert.deepEqual(body.images[0].sameAs, ["IMG-004"]);
  assert.equal(body.turns, 3);
  assert.equal(body.auto, false);
  assert.equal(body.lang, "zh");
});

test("unchecking and checking again are written to the Claude selection, by key", () => {
  const { options, p1 } = setup();
  const off = post(`/__cam/claude/select?session=${session}`, { uncheck: ["IMG-002"] }, options);
  assert.equal(off.body.totals.unchecked, 1);
  const file = JSON.parse(readFileSync(join(claudeSelectionDirOf(options.dataRoot), `${session}.json`), "utf8"));
  assert.deepEqual(Object.keys(file.unchecked), [`${p1}#1`]);
  assert.equal(post(`/__cam/claude/select?session=${session}`, { check: ["IMG-002"] }, options).body.totals.unchecked, 0);
  assert.equal(post(`/__cam/claude/select?session=${session}`, { uncheck: ["IMG-099"] }, options).status, 400);
});

test("images for thumbnails come from the transcript", () => {
  const { options } = setup();
  const { body } = get(`/__cam/claude/image?session=${session}&id=IMG-003&max=72`, options);
  assert.equal(body.dataUrl, `data:image/png;base64,${pngC}`);
});

test("cam_view_image works only with automatic selection on, and returns the original after its label", () => {
  const { options } = setup();
  const off = callClaudeTool("cam_view_image", { sessionId: session, ids: ["IMG-003"] }, options);
  assert.equal(off.isError, true);
  assert.match(off.content[0].text, /没有开自动选图/);
  assert.equal(post(`/__cam/claude/select?session=${session}`, { auto: true }, options).body.auto, true);
  const on = callClaudeTool("cam_view_image", { sessionId: session, ids: ["img-003", "IMG-099"] }, options);
  assert.equal(on.isError, false);
  assert.match(on.content[0].text, /^\[图片 IMG-003 取回的原图｜c\.png｜工具查看的图片｜第 2 轮｜16×8\]$/);
  assert.deepEqual(on.content[1], { type: "image", data: pngC, mimeType: "image/png" });
  assert.match(on.content[2].text, /没有 IMG-099/);
  // Without a session in the call, the one Claude Code started the service for.
  assert.equal(callClaudeTool("cam_view_image", { ids: ["IMG-003"] }, options, { CLAUDE_CODE_SESSION_ID: session }).isError, false);
});
