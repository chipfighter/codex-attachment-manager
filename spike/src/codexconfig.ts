// Purpose: P1-1 — point Codex's built-in openai provider at the local proxy by managing marked blocks
// in config.toml (openai_base_url and respect_system_proxy), and remove exactly those blocks again.
// Nothing else in the file is touched.
// Input (CLI): enable [--port 17891] | disable | status. Codex home comes from CODEX_HOME or %USERPROFILE%\.codex.
// Output: the edited config.toml; a byte copy of the previous file under local/config-backup/ before every change.

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const BEGIN = "# >>> codex-attachment-manager: managed proxy setting, remove it with the tool >>>";
export const END = "# <<< codex-attachment-manager <<<";

function parts(text: string): { bom: string; body: string; eol: string } {
  const bom = text.startsWith("﻿") ? "﻿" : "";
  const body = bom ? text.slice(1) : text;
  return { bom, body, eol: body.includes("\r\n") ? "\r\n" : "\n" };
}

const isTable = (line: string) => /^\s*\[/.test(line);

// TOML top-level keys end at the first table header; a second top-level key would be a duplicate.
function topLevelValue(lines: string[], key: string): string | null {
  for (const line of lines) {
    if (isTable(line)) return null;
    const match = new RegExp(`^\\s*${key.replaceAll(".", "\\.")}\\s*=\\s*(.+?)\\s*(#.*)?$`).exec(line);
    if (match) return match[1];
  }
  return null;
}

function featuresHeader(lines: string[]): number {
  return lines.findIndex((line) => /^\s*\[features\]\s*(#.*)?$/.test(line));
}

// The user's own respect_system_proxy, as a top-level dotted key or inside [features]; null when absent.
function userRespectSystemProxy(lines: string[]): string | null {
  const dotted = topLevelValue(lines, "features.respect_system_proxy");
  if (dotted !== null) return dotted;
  const header = featuresHeader(lines);
  if (header < 0) return null;
  for (const line of lines.slice(header + 1)) {
    if (isTable(line)) break;
    const match = /^\s*respect_system_proxy\s*=\s*(\S+)/.exec(line);
    if (match) return match[1];
  }
  return null;
}

// Removes every managed block; the blank line enable adds after the top block goes with it.
export function disableProxy(text: string): { text: string; changed: boolean } {
  const { bom, body, eol } = parts(text);
  const lines = body.split(eol);
  const kept: string[] = [];
  let changed = false;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() !== BEGIN) { kept.push(lines[i]); continue; }
    const end = lines.findIndex((line, j) => j > i && line.trim() === END);
    if (end < 0) throw new Error("a managed block in config.toml has no end marker");
    const atTop = kept.length === 0;
    i = end;
    if (atTop && lines[i + 1] === "") i++;
    changed = true;
  }
  return changed ? { text: bom + kept.join(eol), changed } : { text, changed: false };
}

// Codex needs two settings to reach the proxy on Windows: openai_base_url (top level, so it goes first in the
// file) and features.respect_system_proxy, without which Codex sends even localhost through HTTP(S)_PROXY.
export function enableProxy(text: string, url: string): { text: string; changed: boolean } {
  const { bom, body, eol } = parts(disableProxy(text).text);
  const lines = body.split(eol);
  if (topLevelValue(lines, "openai_base_url") !== null) throw new Error("config.toml already sets openai_base_url; not overwriting it");
  const own = userRespectSystemProxy(lines);
  if (own !== null && own !== "true") throw new Error("config.toml turns respect_system_proxy off; not overriding it");
  const header = featuresHeader(lines);
  const top = [BEGIN, `openai_base_url = "${url}"`];
  if (own === null && header < 0) top.push("features.respect_system_proxy = true");
  top.push(END, "");
  if (own === null && header >= 0) lines.splice(header + 1, 0, BEGIN, "respect_system_proxy = true", END);
  const next = bom + top.join(eol) + eol + lines.join(eol);
  return { text: next, changed: next !== text };
}

export function proxyStatus(text: string): { enabled: boolean; url: string | null; conflict: boolean; respectSystemProxy: "managed" | "user" | "off" | "absent" } {
  const { body, eol } = parts(text);
  const lines = body.split(eol);
  const enabled = lines.some((line) => line.trim() === BEGIN);
  const begin = lines.findIndex((line) => line.trim() === BEGIN);
  const urlLine = begin >= 0 ? lines.slice(begin).find((line) => /^\s*openai_base_url\s*=/.test(line)) : undefined;
  const base = parts(disableProxy(text).text);
  const baseLines = base.body.split(base.eol);
  const own = userRespectSystemProxy(baseLines);
  const managedRsp = enabled && lines.some((line, i) => /respect_system_proxy\s*=\s*true/.test(line) && lines.slice(0, i).reverse().find((l) => l.trim() === BEGIN || l.trim() === END)?.trim() === BEGIN);
  return {
    enabled,
    url: urlLine ? (/"([^"]*)"/.exec(urlLine)?.[1] ?? null) : null,
    conflict: topLevelValue(baseLines, "openai_base_url") !== null,
    respectSystemProxy: managedRsp ? "managed" : own === "true" ? "user" : own !== null ? "off" : "absent",
  };
}

export function codexHome(): string {
  return process.env.CODEX_HOME?.trim() || join(homedir(), ".codex");
}

function main(): void {
  const command = process.argv[2];
  const localRoot = join(resolve(dirname(fileURLToPath(import.meta.url)), "../.."), "local");
  const config = join(codexHome(), "config.toml");
  const current = existsSync(config) ? readFileSync(config, "utf8") : "";
  const write = (next: string) => {
    mkdirSync(join(localRoot, "config-backup"), { recursive: true });
    const stamp = new Date().toISOString().replaceAll(":", "-");
    if (existsSync(config)) copyFileSync(config, join(localRoot, "config-backup", `config.toml.${stamp}`));
    writeFileSync(config, next, "utf8");
  };
  if (command === "enable") {
    const index = process.argv.indexOf("--port");
    const port = Number(index >= 0 ? process.argv[index + 1] : 17891);
    // "localhost", not 127.0.0.1: Codex on Windows applies the system proxy's "<local>" bypass only to
    // host names without a dot, so 127.0.0.1 would be sent to the user's system proxy.
    const { text, changed } = enableProxy(current, `http://localhost:${port}/backend-api/codex`);
    if (changed) write(text);
    console.log(JSON.stringify({ command, changed, ...proxyStatus(text) }));
  } else if (command === "disable") {
    const { text, changed } = disableProxy(current);
    if (changed) write(text);
    console.log(JSON.stringify({ command, changed, ...proxyStatus(text) }));
  } else if (command === "status") {
    console.log(JSON.stringify({ command, configExists: existsSync(config), ...proxyStatus(current) }));
  } else {
    throw new Error("usage: codexconfig.ts enable [--port N] | disable | status");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
