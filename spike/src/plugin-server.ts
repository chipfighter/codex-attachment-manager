// Purpose: P3-3 — the plugin's MCP server, started by Codex for each session. It keeps the engine (local proxy)
// running — at start and every 3 seconds, so a crashed engine comes back — and serves the panel's data tools:
// the thread's images and their state, check/uncheck, and the images themselves.
// Only the user may check or uncheck: calls the model makes (they carry Codex's turn metadata) are refused.
// P4 — the panel page itself (an MCP App resource). cam_panel declares a "thread" entrypoint, so Codex lists the panel
// under the side panel's New Tab → 插件和 MCP, and the user opens it without the model.
// Input: MCP JSON-RPC over stdio. Env: CAM_ENGINE_PORT (default 17891), CAM_NO_ENGINE=1 (tests), CAM_DATA_DIR.
// Output: tool results; <data dir>/plugin-server.jsonl (events and counts only, no conversation content).

import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";
import { codexHome } from "./codexconfig.ts";
import { DEFAULT_PORT, ensureEngine } from "./engine.ts";
import { applySelection, imageFor, loadPanelState, type PanelState } from "./panel-state.ts";
import { dataDir } from "./paths.ts";

type Json = Record<string, any>;
const here = dirname(fileURLToPath(import.meta.url));
// Kept fixed: Codex Desktop on Windows may show a blank panel after a resource URI changes (openai/codex#47512).
export const PANEL_URI = "ui://codex-attachment-manager/panel.html";
export const PANEL_MIME = "text/html;profile=mcp-app";
const APP_ONLY = { ui: { visibility: ["app"] } };
const threadArg = { threadId: { type: "string", description: "任务 ID；面板调用时由 Codex 自动带上。" } };

export const TOOLS = [
  {
    name: "cam_panel",
    title: "上下文素材",
    description: "上下文素材面板：查看这个任务里的历史图片，勾选下一条消息要发给模型的图片。由用户在侧边面板里打开，模型不需要调用。",
    inputSchema: { type: "object", properties: { ...threadArg } },
    _meta: { ui: { resourceUri: PANEL_URI, visibility: ["app"] }, "openai/ui": { entrypoints: [{ type: "thread" }] } },
  },
  {
    name: "cam_set_selection",
    title: "上下文素材：勾选",
    description: "素材面板内部使用：勾选或取消图片。只有用户能操作，模型调用会被拒绝。",
    inputSchema: { type: "object", properties: { ...threadArg, uncheck: { type: "array", items: { type: "string" } }, check: { type: "array", items: { type: "string" } }, checkAll: { type: "boolean" } } },
    _meta: APP_ONLY,
  },
  {
    name: "cam_image",
    title: "上下文素材：图片",
    description: "素材面板内部使用：读取一张图片的缩略图或预览图。模型不需要调用。",
    inputSchema: { type: "object", properties: { ...threadArg, id: { type: "string" }, maxSide: { type: "number" } }, required: ["id"] },
    _meta: APP_ONLY,
  },
];

// A stack of pictures, drawn for light and dark themes (Codex takes https or data URLs only).
const ICON_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="6" width="14" height="14" rx="2.5"/><path d="M7 3h10.5A3.5 3.5 0 0 1 21 6.5V16"/><circle cx="8" cy="11" r="1.5"/><path d="m3.5 18 4.5-4.5 3 3 2-2 3.5 3.5"/></svg>';
const icon = (theme: "light" | "dark", color: string) => ({
  src: `data:image/svg+xml;base64,${Buffer.from(ICON_SVG.replace("currentColor", color)).toString("base64")}`,
  mimeType: "image/svg+xml", sizes: ["any"], theme,
});
export const SERVER_INFO = { name: "codex-attachment-manager", title: "上下文素材管理器", version: "0.1.0", icons: [icon("light", "#5d5d5d"), icon("dark", "#cdcdcd")] };

export function readResource(uri: string): Json {
  if (uri !== PANEL_URI) throw new Error(`unknown resource ${uri}`);
  const text = readFileSync(join(here, "panel.html"), "utf8");
  // The page is self-contained: images arrive as data URLs through tool calls, nothing is fetched.
  return { contents: [{ uri, mimeType: PANEL_MIME, text, _meta: { ui: { csp: { connectDomains: [], resourceDomains: [] }, prefersBorder: false } } }] };
}

// Whether this instance last found the engine running; null until the first check (and in tests).
let engineRunning: boolean | null = null;

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
  if (name === "cam_panel") {
    const state = loadPanelState(threadId, options);
    return { content: [{ type: "text", text: summary(state) }], structuredContent: { ...state, engineRunning } };
  }
  if (name === "cam_set_selection") {
    if (fromModel(meta)) throw new Error("只有用户能勾选或取消图片；需要某张图时，请回复“需要 IMG-xxx”。");
    const state = applySelection(threadId, { uncheck: args.uncheck, check: args.check, checkAll: args.checkAll }, options);
    return { content: [{ type: "text", text: summary(state) }], structuredContent: { ...state, engineRunning } };
  }
  if (name === "cam_image") {
    const image = imageFor(threadId, String(args.id), Number(args.maxSide ?? 160), options);
    // The image data goes in _meta, which only the panel sees.
    return { content: [{ type: "text", text: image.dataUrl ? "ok" : "无法显示" }], structuredContent: { id: image.id, available: image.dataUrl !== null }, _meta: { dataUrl: image.dataUrl } };
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
    engineRunning = result.state !== "failed";
  };
  log({ event: "start", ppid: process.ppid });
  // Codex starts several instances at once; a little jitter keeps them from racing to start the engine.
  setTimeout(supervise, Math.floor(Math.random() * 400));
  // Short enough that a crashed engine is back within Codex's own retry window.
  setInterval(supervise, 3000);
  process.stdin.on("close", () => { log({ event: "stdin-closed" }); process.exit(0); });
  createInterface({ input: process.stdin, crlfDelay: Infinity }).on("line", (line) => {
    if (!line.trim()) return;
    let message: Json;
    try { message = JSON.parse(line); } catch { return; }
    const { id, method, params = {} } = message;
    if (method === "initialize") {
      send({ id, result: { protocolVersion: params.protocolVersion ?? "2025-06-18", capabilities: { tools: {}, resources: {} }, serverInfo: SERVER_INFO } });
    } else if (method === "tools/list") {
      send({ id, result: { tools: TOOLS } });
    } else if (method === "resources/list") {
      send({ id, result: { resources: [{ uri: PANEL_URI, name: "上下文素材面板", mimeType: PANEL_MIME }] } });
    } else if (method === "resources/templates/list") {
      send({ id, result: { resourceTemplates: [] } });
    } else if (method === "resources/read") {
      try {
        send({ id, result: readResource(params.uri) });
        log({ event: "resources/read" });
      } catch (error) {
        send({ id, error: { code: -32002, message: error instanceof Error ? error.message : String(error) } });
      }
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
