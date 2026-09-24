// Purpose: T9b — a minimal stdio MCP server with one `ping` tool that records what Codex sends in tools/call,
// including `_meta`, so we can see whether a local MCP server learns which thread called it.
// Input: MCP JSON-RPC over stdio (newline-delimited); CAM_PROBE_LOG env var names the output file.
// Output: one JSON line per tools/call appended to that file (local only).

import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const log = process.env.CAM_PROBE_LOG;
const send = (message: Record<string, unknown>) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);

createInterface({ input: process.stdin, crlfDelay: Infinity }).on("line", (line) => {
  if (!line.trim()) return;
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  switch (message.method) {
    case "initialize":
      send({ id: message.id, result: { protocolVersion: message.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "cam_probe", version: "0.0.0" } } });
      break;
    case "tools/list":
      send({ id: message.id, result: { tools: [{ name: "ping", description: "Phase 0 probe: returns pong.", inputSchema: { type: "object", properties: {} } }] } });
      break;
    case "tools/call":
      if (log) appendFileSync(log, `${JSON.stringify({ at: new Date().toISOString(), params: message.params })}\n`);
      send({ id: message.id, result: { content: [{ type: "text", text: "pong" }] } });
      break;
    default:
      send({ id: message.id, error: { code: -32601, message: `unsupported: ${message.method}` } });
  }
});
