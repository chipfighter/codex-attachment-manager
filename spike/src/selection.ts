// Purpose: P2 — per-thread selection state: which image occurrences the user unchecked. Written by the CLI (later
// the panel), read by the proxy on every request of that thread.
// Input/Output: local/selection/<thread id>.json, e.g. { "threadId": "…", "unchecked": { "<key>": { "id": "IMG-003", "at": "…" } } }.

import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type Selection = { threadId: string; unchecked: Record<string, { id: string; at: string }> };

export const selectionDir = join(resolve(dirname(fileURLToPath(import.meta.url)), "../.."), "local", "selection");
const THREAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const cache = new Map<string, { mtimeMs: number; size: number; selection: Selection }>();

function fileFor(threadId: string, dir: string): string {
  if (!THREAD_ID.test(threadId)) throw new Error(`not a thread id: ${threadId}`);
  return join(dir, `${threadId}.json`);
}

export function readSelection(threadId: string, dir = selectionDir): Selection {
  const file = fileFor(threadId, dir);
  if (!existsSync(file)) return { threadId, unchecked: {} };
  const { mtimeMs, size } = statSync(file);
  const known = cache.get(file);
  if (known && known.mtimeMs === mtimeMs && known.size === size) return known.selection;
  const selection = JSON.parse(readFileSync(file, "utf8")) as Selection;
  cache.set(file, { mtimeMs, size, selection });
  return selection;
}

// Written to a temporary file first, so the proxy never reads a half-written selection.
export function writeSelection(selection: Selection, dir = selectionDir): void {
  const file = fileFor(selection.threadId, dir);
  mkdirSync(dir, { recursive: true });
  writeFileSync(`${file}.tmp`, JSON.stringify(selection, null, 2));
  renameSync(`${file}.tmp`, file);
}
