// Purpose: P2 — per-thread selection state: which image occurrences the user unchecked. Written by the CLI (later
// the panel), read by the proxy on every request of that thread.
// P3 — a forked thread starts with what its parent had unchecked when the fork was made (user decision 2026-09-24);
// from then on the two are independent.
// Input/Output: <data dir>/selection/<thread id>.json, e.g. { "threadId": "…", "unchecked": { "<key>": { "id": "IMG-003", "at": "…" } } }.

import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { selectionDirOf } from "./paths.ts";
import { forkOrigin } from "./thread-index.ts";

export type Selection = { threadId: string; unchecked: Record<string, { id: string; at: string }>; inheritedFrom?: string };

export const selectionDir = selectionDirOf();
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

// The thread's own selection; a fork without one takes the images its parent had unchecked by the time of the fork
// (a fork of a fork asks its own parent in turn) and keeps them as its own file from then on.
export function effectiveSelection(threadId: string, sessionsDir: string, dir = selectionDir, depth = 0): Selection {
  if (existsSync(fileFor(threadId, dir)) || depth > 16) return readSelection(threadId, dir);
  const origin = forkOrigin(sessionsDir, threadId);
  if (!origin) return { threadId, unchecked: {} };
  const parent = effectiveSelection(origin.parent, sessionsDir, dir, depth + 1);
  const unchecked = Object.fromEntries(Object.entries(parent.unchecked).filter(([, entry]) => !origin.at || entry.at <= origin.at));
  if (!Object.keys(unchecked).length) return { threadId, unchecked: {} };
  const inherited: Selection = { threadId, unchecked, inheritedFrom: origin.parent };
  writeSelection(inherited, dir);
  return inherited;
}
