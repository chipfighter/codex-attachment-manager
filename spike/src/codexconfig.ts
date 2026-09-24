// Purpose: P1-1 — point Codex's built-in openai provider at the local proxy by managing one marked block
// in config.toml, and remove exactly that block again. Nothing else in the file is touched.
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

function block(lines: string[]): { start: number; end: number } | null {
  const start = lines.findIndex((line) => line.trim() === BEGIN);
  if (start < 0) return null;
  const end = lines.findIndex((line, i) => i > start && line.trim() === END);
  if (end < 0) throw new Error("the managed block in config.toml has no end marker");
  return { start, end };
}

// TOML top-level keys end at the first table header; a second top-level openai_base_url would be a duplicate key.
function hasTopLevelConflict(lines: string[], managed: { start: number; end: number } | null): boolean {
  for (const [i, line] of lines.entries()) {
    if (managed && i >= managed.start && i <= managed.end) continue;
    if (/^\s*\[/.test(line)) return false;
    if (/^\s*openai_base_url\s*=/.test(line)) return true;
  }
  return false;
}

export function proxyStatus(text: string): { enabled: boolean; url: string | null; conflict: boolean } {
  const { body, eol } = parts(text);
  const lines = body.split(eol);
  const managed = block(lines);
  const line = managed ? lines.slice(managed.start + 1, managed.end).find((l) => /^\s*openai_base_url\s*=/.test(l)) : undefined;
  return { enabled: Boolean(managed), url: line ? (/"([^"]*)"/.exec(line)?.[1] ?? null) : null, conflict: hasTopLevelConflict(lines, managed) };
}

export function enableProxy(text: string, url: string): { text: string; changed: boolean } {
  const { bom, body, eol } = parts(text);
  const lines = body.split(eol);
  const managed = block(lines);
  if (hasTopLevelConflict(lines, managed)) throw new Error("config.toml already sets openai_base_url; not overwriting it");
  const setting = `openai_base_url = "${url}"`;
  if (managed) {
    const current = lines.slice(managed.start + 1, managed.end);
    if (current.length === 1 && current[0] === setting) return { text, changed: false };
    lines.splice(managed.start + 1, managed.end - managed.start - 1, setting);
    return { text: bom + lines.join(eol), changed: true };
  }
  // At the very top the key is always top-level, whatever tables follow; a blank line separates it from the user's text.
  return { text: bom + [BEGIN, setting, END, ""].join(eol) + eol + body, changed: true };
}

export function disableProxy(text: string): { text: string; changed: boolean } {
  const { bom, body, eol } = parts(text);
  const begin = body.indexOf(BEGIN);
  if (begin < 0) return { text, changed: false };
  const end = body.indexOf(END, begin);
  if (end < 0) throw new Error("the managed block in config.toml has no end marker");
  let cut = end + END.length;
  if (body.startsWith(eol, cut)) cut += eol.length;
  // The separator line is ours only when the block still sits where enable put it.
  if (begin === 0 && body.startsWith(eol, cut)) cut += eol.length;
  return { text: bom + body.slice(0, begin) + body.slice(cut), changed: true };
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
    const { text, changed } = enableProxy(current, `http://127.0.0.1:${port}/backend-api/codex`);
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
