// Purpose: P3-3 — the plugin's MCP server, started by Codex for each session. It keeps the engine (local proxy)
// running — at start and every few seconds, so a crashed engine comes back — and serves the panel's data tools:
// the thread's images and their state, check/uncheck, and thumbnails.
// Only the user may check or uncheck: calls the model makes (they carry Codex's turn metadata) are refused.
// Input: MCP JSON-RPC over stdio. Env: CAM_ENGINE_PORT (default 17891), CAM_NO_ENGINE=1 (tests), CAM_DATA_DIR.
// Output: tool results; <data dir>/plugin-server.jsonl (events and counts only, no conversation content).

import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { codexHome } from "./codexconfig.ts";
import { DEFAULT_PORT, ensureEngine } from "./engine.ts";
import { applySelection, loadPanelState, thumbnailFor, type PanelState } from "./panel-state.ts";
import { dataDir } from "./paths.ts";

type Json = Record<string, any>;
const APP_ONLY = { ui: { visibility: ["app"] } };
const threadArg = { threadId: { type: "string", description: "任务 ID；面板调用时由 Codex 自动带上。" } };

export const TOOLS = [
  {
    name: "cam_panel_state",
    title: "素材面板：读取",
    description: "素材面板内部使用：读取当前任务的图片列表和勾选状态。模型不需要调用。",
    inputSchema: { type: "object", properties: { ...threadArg } },
    _meta: APP_ONLY,
  },
  {
    name: "cam_set_selection",
    title: "素材面板：勾选",
    description: "素材面板内部使用：勾选或取消图片。只有用户能操作，模型调用会被拒绝。",
    inputSchema: { type: "object", properties: { ...threadArg, uncheck: { type: "array", items: { type: "string" } }, check: { type: "array", items: { type: "string" } }, checkAll: { type: "boolean" } } },
    _meta: APP_ONLY,
  },
  {
    name: "cam_thumbnail",
    title: "素材面板：缩略图",
    description: "素材面板内部使用：读取一张图片的缩略图。模型不需要调用。",
    inputSchema: { type: "object", properties: { ...threadArg, id: { type: "string" }, maxSide: { type: "number" } }, required: ["id"] },
    _meta: APP_ONLY,
  },
];

function log(entry: Json): void {
  const root = dataDir();
  mkdirSync(root, { recursive: true });
  appendFileSync(join(root, "plugin-server.jsonl"), `${JSON.stringify({ at: new Date().toISOString(), pid: process.pid, ...entry })}\n`);
}

// Codex adds turn metadata to calls the model makes; the panel's own calls carry only the thread id.
export function fromModel(meta: Json | undefined): boolean {
  return !!meta && meta["x-codex-turn-metadata"] !== undefined;
}

export function threadOf(args: Json, meta: Json | undefined): string | null {
  return args.threadId ?? meta?.threadId ?? meta?.thread_id ?? meta?.["x-codex-turn-metadata"]?.thread_id ?? null;
}

const summary = (state: PanelState) => `共 ${state.totals.images} 张图，取消了 ${state.totals.unchecked} 张。`;

export function callTool(name: string, args: Json, meta: Json | undefined, sessionsDir = join(codexHome(), "sessions")): Json {
  const threadId = threadOf(args, meta);
  if (!threadId) throw new Error("不知道是哪个任务：缺少 threadId");
  const options = { sessionsDir };
  if (name === "cam_panel_state") {
    const state = loadPanelState(threadId, options);
    return { content: [{ type: "text", text: summary(state) }], structuredContent: state };
  }
  if (name === "cam_set_selection") {
    if (fromModel(meta)) throw new Error("只有用户能勾选或取消图片；需要某张图时，请回复“需要 IMG-xxx”。");
    const state = applySelection(threadId, { uncheck: args.uncheck, check: args.check, checkAll: args.checkAll }, options);
    return { content: [{ type: "text", text: summary(state) }], structuredContent: state };
  }
  if (name === "cam_thumbnail") {
    const thumb = thumbnailFor(threadId, String(args.id), Number(args.maxSide ?? 96), options);
    // The image data goes in _meta, which only the panel sees.
    return { content: [{ type: "text", text: thumb.dataUrl ? "ok" : "无缩略图" }], structuredContent: { id: thumb.id, available: thumb.dataUrl !== null }, _meta: { dataUrl: thumb.dataUrl } };
  }
  throw new Error(`unknown tool ${name}`);
}

function main(): void {
  const send = (message: Json) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  const port = Number(process.env.CAM_ENGINE_PORT ?? DEFAULT_PORT);
  let engineState = "";
  const supervise = async () => {
    if (process.env.CAM_NO_ENGINE === "1") return;
    const result = await ensureEngine({ port });
    if (result.state !== "running" || engineState !== "running") log({ event: "engine", state: result.state, enginePid: result.health?.pid ?? null });
    engineState = result.state;
  };
  log({ event: "start", ppid: process.ppid });
  // Codex starts several instances at once; a little jitter keeps them from racing to start the engine.
  setTimeout(supervise, Math.floor(Math.random() * 400));
  setInterval(supervise, 10_000);
  process.stdin.on("close", () => { log({ event: "stdin-closed" }); process.exit(0); });
  createInterface({ input: process.stdin, crlfDelay: Infinity }).on("line", (line) => {
    if (!line.trim()) return;
    let message: Json;
    try { message = JSON.parse(line); } catch { return; }
    const { id, method, params = {} } = message;
    if (method === "initialize") {
      send({ id, result: { protocolVersion: params.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "codex-attachment-manager", version: "0.1.0" } } });
    } else if (method === "tools/list") {
      send({ id, result: { tools: TOOLS } });
    } else if (method === "tools/call") {
      try {
        const result = callTool(params.name, params.arguments ?? {}, params._meta);
        log({ event: "tools/call", name: params.name, fromModel: fromModel(params._meta) });
        send({ id, result });
      } catch (error) {
        log({ event: "tools/call", name: params.name, fromModel: fromModel(params._meta), error: String(error) });
        send({ id, result: { isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }] } });
      }
    } else if (method === "ping") {
      send({ id, result: {} });
    } else if (id !== undefined) {
      send({ id, error: { code: -32601, message: `unsupported: ${method}` } });
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
