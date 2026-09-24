// Purpose: P3-1 — probe what Codex Desktop offers an MCP App on Windows: whether the widget renders, finishes the
// MCP Apps handshake, calls back into this server, shows data-URL images and reaches localhost; and when and how often
// Codex starts this server (per thread or shared).
// Input: MCP JSON-RPC over stdio (newline-delimited); the widget page is panel-probe.html next to this file.
// Output: one JSON line per event in local/p3/panel-probe.jsonl (local only; no conversation content is logged).

import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

type Json = Record<string, any>;
const here = dirname(fileURLToPath(import.meta.url));
const logDir = join(resolve(here, "../.."), "local", "p3");
const RESOURCE = "ui://codex-attachment-manager/probe.html";
const MIME = "text/html;profile=mcp-app";
let calls = 0;

function log(entry: Json): void {
  mkdirSync(logDir, { recursive: true });
  appendFileSync(join(logDir, "panel-probe.jsonl"), `${JSON.stringify({ at: new Date().toISOString(), pid: process.pid, ...entry })}\n`);
}

const send = (message: Json) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);

const TOOLS = [
  {
    name: "cam_panel_probe",
    title: "素材面板（试验）",
    description: "打开 Codex 素材管理器的界面试验面板。用户要求打开素材面板时调用，不需要参数。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    _meta: { ui: { resourceUri: RESOURCE }, "openai/ui": { preferredModelDisplayMode: "inline" } },
  },
  {
    name: "cam_probe_ping",
    title: "素材面板回调（试验）",
    description: "素材面板内部使用：面板页面回调插件服务。模型不需要调用。",
    inputSchema: { type: "object", properties: { reason: { type: "string" }, report: { type: "object" } } },
    _meta: { ui: { resourceUri: RESOURCE, visibility: ["app"] } },
  },
];

function handle(message: Json): void {
  const { id, method, params = {} } = message;
  if (method === "initialize") {
    log({ event: "initialize", client: params.clientInfo ?? null, protocolVersion: params.protocolVersion ?? null, capabilities: params.capabilities ?? null });
    send({ id, result: { protocolVersion: params.protocolVersion ?? "2025-06-18", capabilities: { tools: {}, resources: {} }, serverInfo: { name: "codex-attachment-manager-probe", version: "0.0.1" } } });
  } else if (method === "tools/list") {
    send({ id, result: { tools: TOOLS } });
  } else if (method === "tools/call") {
    calls++;
    log({ event: "tools/call", name: params.name, arguments: params.arguments ?? null, meta: params._meta ?? null });
    const meta = params._meta ?? {};
    const threadId = meta.threadId ?? meta.thread_id ?? null;
    if (params.name === "cam_panel_probe") {
      send({ id, result: { content: [{ type: "text", text: "已打开素材面板（试验版）。" }], structuredContent: { pid: process.pid, threadId, calls } } });
    } else if (params.name === "cam_probe_ping") {
      send({ id, result: { content: [{ type: "text", text: "pong" }], structuredContent: { pid: process.pid, calls, at: new Date().toISOString() } } });
    } else {
      send({ id, error: { code: -32602, message: `unknown tool ${params.name}` } });
    }
  } else if (method === "resources/list") {
    send({ id, result: { resources: [{ uri: RESOURCE, name: "素材面板（试验）", mimeType: MIME }] } });
  } else if (method === "resources/templates/list") {
    send({ id, result: { resourceTemplates: [] } });
  } else if (method === "resources/read") {
    log({ event: "resources/read", uri: params.uri ?? null });
    const text = readFileSync(join(here, "panel-probe.html"), "utf8");
    send({ id, result: { contents: [{ uri: RESOURCE, mimeType: MIME, text, _meta: { ui: { csp: { connectDomains: ["http://localhost:17891"], resourceDomains: [] }, prefersBorder: true } } }] } });
  } else if (method === "ping") {
    send({ id, result: {} });
  } else if (id !== undefined) {
    log({ event: "unsupported", method });
    send({ id, error: { code: -32601, message: `unsupported: ${method}` } });
  }
}

// Which process started us, and whether Codex passes thread identity in the environment (names and ids only).
log({ event: "start", ppid: process.ppid, argv: process.argv.slice(1), env: Object.fromEntries(Object.entries(process.env).filter(([name]) => /THREAD|SESSION/i.test(name) && !/TOKEN|KEY|SECRET/i.test(name))) });
process.stdin.on("close", () => { log({ event: "stdin-closed", calls }); process.exit(0); });
createInterface({ input: process.stdin, crlfDelay: Infinity }).on("line", (line) => {
  if (!line.trim()) return;
  try { handle(JSON.parse(line)); } catch (error) { log({ event: "error", error: String(error) }); }
});
