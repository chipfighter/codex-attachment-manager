// Purpose: P3-4 — what installing and uninstalling change, as pure functions over the current file contents:
// config.toml gets the proxy settings and the plugin's MCP server; ~/.codex/.env gets NO_PROXY only when the user's
// environment proxy would otherwise swallow requests to this machine. Uninstall removes exactly those blocks.
// Input: current texts and the user's persisted proxy variables. Output: next texts (envText null = delete the file).

import { coversLoopback, disableMcpServer, disableProxy, enableMcpServer, enableNoProxy, enableProxy, noProxyValue } from "./codexconfig.ts";

export const SERVER_NAME = "codex_attachment_manager";

export type UserProxyEnv = { httpProxy: string | null; noProxy: string | null };
export type Plan = { configText: string; configChanged: boolean; envText: string | null; envChanged: boolean; notes: string[] };

// Codex's image client follows the environment proxy; without NO_PROXY for loopback it cannot reach the engine.
export function needsNoProxy(env: UserProxyEnv): boolean {
  return !!env.httpProxy && !coversLoopback(env.noProxy);
}

export function planInstall(input: { configText: string; envText: string | null; env: UserProxyEnv; port: number; nodePath: string; serverScript: string }): Plan {
  const notes: string[] = [];
  const proxied = enableProxy(input.configText, `http://localhost:${input.port}/backend-api/codex`);
  const served = enableMcpServer(proxied.text, SERVER_NAME, input.nodePath, [input.serverScript]);
  let envText = input.envText;
  let envChanged = false;
  if (needsNoProxy(input.env)) {
    const next = enableNoProxy(input.envText ?? "", noProxyValue(input.env.noProxy));
    envText = next.text;
    envChanged = next.changed;
    notes.push("写入 .env 的 NO_PROXY：环境变量里有代理，而且没有覆盖本机地址");
  } else {
    // A block from an earlier install is no longer needed.
    const cleared = input.envText === null ? { text: null, changed: false } : disableProxy(input.envText);
    envText = cleared.text;
    envChanged = cleared.changed;
  }
  return { configText: served.text, configChanged: served.text !== input.configText, envText: emptyToNull(envText), envChanged, notes };
}

export function planUninstall(input: { configText: string; envText: string | null }): Plan {
  const config = disableMcpServer(disableProxy(input.configText).text);
  const env = input.envText === null ? { text: null, changed: false } : disableProxy(input.envText);
  return { configText: config.text, configChanged: config.text !== input.configText, envText: emptyToNull(env.text), envChanged: env.changed, notes: [] };
}

// A .env that held nothing but our block is removed rather than left empty.
function emptyToNull(text: string | null): string | null {
  return text === null || !text.replace(/^﻿/, "").trim() ? null : text;
}
