// Purpose: v0.4 — the plugin service under Claude Code (callClaudeTool in plugin-server.ts): the panel's data for a
// session, checking and unchecking, images for thumbnails, automatic selection and the model's cam_view_image, all
// from the session's transcript and the selection kept for Claude sessions.
// Input: a synthetic transcript under a temporary Claude config dir and a temporary data dir; output: assertions only.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { callClaudeTool, claudeToolsFor } from "../../plugin/src/plugin-server.ts";
import { claudeSelectionDirOf } from "../../plugin/src/paths.ts";
import { pngC, usualSession } from "./claude-fixtures.ts";

process.env.CAM_LANG = "zh";
const session = "11111111-2222-4333-8444-555555555555";

function setup() {
  const home = mkdtempSync(join(tmpdir(), "cam-claude-home-"));
  const dataRoot = mkdtempSync(join(tmpdir(), "cam-claude-data-"));
  const { t, p1 } = usualSession();
  mkdirSync(join(home, "projects", "D--work"), { recursive: true });
  writeFileSync(join(home, "projects", "D--work", `${session}.jsonl`), t.records.map((record) => JSON.stringify(record)).join("\n") + "\n");
  return { options: { home, dataRoot }, p1 };
}
const json = (result: any) => JSON.parse(result.content[0].text);

test("under Claude Code only the fetch tool is listed for the model", () => {
  assert.deepEqual(claudeToolsFor("zh").map((tool) => tool.name), ["cam_view_image"]);
});

test("the panel's data for a session: images, turns, title, the ids the reply asked for", () => {
  const { options } = setup();
  const state = json(callClaudeTool("cam_panel", { sessionId: session }, options));
  assert.deepEqual(state.images.map((image: any) => [image.id, image.kind, image.turn, image.checked]), [["IMG-001", "upload", 1, true], ["IMG-002", "upload", 1, true], ["IMG-003", "view", 2, true], ["IMG-004", "upload", 3, true]]);
  assert.equal(state.title, "What are these?");
  assert.equal(state.started, true);
  assert.deepEqual(state.images[0].sameAs, ["IMG-004"]);
  assert.equal(state.turns, 3);
  assert.equal(state.auto, false);
});

test("unchecking and checking again are written to the Claude selection, by key", () => {
  const { options, p1 } = setup();
  const state = json(callClaudeTool("cam_set_selection", { sessionId: session, uncheck: ["IMG-002"] }, options));
  assert.equal(state.totals.unchecked, 1);
  const file = JSON.parse(readFileSync(join(claudeSelectionDirOf(options.dataRoot), `${session}.json`), "utf8"));
  assert.deepEqual(Object.keys(file.unchecked), [`${p1}#1`]);
  assert.equal(json(callClaudeTool("cam_set_selection", { sessionId: session, check: ["IMG-002"] }, options)).totals.unchecked, 0);
  assert.throws(() => callClaudeTool("cam_panel", { sessionId: "not-a-session" }, options));
});

test("images for thumbnails come from the transcript", () => {
  const { options } = setup();
  const image = json(callClaudeTool("cam_image", { sessionId: session, id: "IMG-003", maxSide: 160 }, options));
  assert.equal(image.available, true);
  assert.equal(image.dataUrl, `data:image/png;base64,${pngC}`);
});

test("cam_view_image works only with automatic selection on, and returns the original after its label", () => {
  const { options } = setup();
  const off = callClaudeTool("cam_view_image", { sessionId: session, ids: ["IMG-003"] }, options);
  assert.equal(off.isError, true);
  assert.match(off.content[0].text, /没有开自动选图/);
  callClaudeTool("cam_set_selection", { sessionId: session, auto: true }, options);
  const on = callClaudeTool("cam_view_image", { sessionId: session, ids: ["img-003", "IMG-099"] }, options);
  assert.equal(on.isError, false);
  assert.match(on.content[0].text, /^\[图片 IMG-003 取回的原图｜c\.png｜工具查看的图片｜第 2 轮｜16×8\]$/);
  assert.deepEqual(on.content[1], { type: "image", data: pngC, mimeType: "image/png" });
  assert.match(on.content[2].text, /没有 IMG-099/);
});

test("the session comes from the call, else from the session Claude Code started the service for", () => {
  const { options } = setup();
  assert.equal(json(callClaudeTool("cam_panel", {}, options, { CLAUDE_CODE_SESSION_ID: session })).images.length, 4);
  const engine = json(callClaudeTool("cam_engine", {}, options));
  assert.equal(typeof engine.port, "number");
});
