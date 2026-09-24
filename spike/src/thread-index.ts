// Purpose: P2 — the image timeline of one thread, read from its rollout (read-only): every image occurrence in
// history order with a stable id (IMG-001…), turn number, name, size and content hashes. The CLI and the proxy both
// derive it from the same files, so they agree on ids without sharing state.
// Input: the sessions directory and a thread id. Output: ThreadIndex (in memory; files are parsed incrementally).

import { closeSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { findImages, type ImageRef } from "./images.ts";
import { decodePng } from "./png.ts";

type Json = Record<string, any>;
export type IndexedImage = ImageRef & { id: string; turn: number | null; bytes: number; pixelSha256: string | null };
export type ThreadIndex = { threadId: string; images: IndexedImage[]; byKey: Map<string, IndexedImage>; turns: number };
type Parsed = { offset: number; type: string; payload: Json };
type FileCache = { size: number; mtimeMs: number; parsedTo: number; records: Parsed[] };

const SEGMENT_NAME = /rollout-[0-9T:-]+-([0-9a-f-]{36})(?:_([0-9a-f-]{36}))?\.jsonl$/;
const files = new Map<string, FileCache>();
const pixelHashes = new Map<string, string | null>();

function walk(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = join(directory, entry.name);
    return entry.isDirectory() ? walk(full) : entry.isFile() ? [full] : [];
  });
}

// Rollouts are append-only: parse only the complete lines added since the last read.
function records(file: string): Parsed[] {
  const stat = statSync(file);
  let cache = files.get(file);
  if (!cache || stat.size < cache.parsedTo) cache = { size: 0, mtimeMs: 0, parsedTo: 0, records: [] };
  if (stat.size !== cache.size || stat.mtimeMs !== cache.mtimeMs) {
    const length = stat.size - cache.parsedTo;
    const buffer = Buffer.alloc(length);
    const fd = openSync(file, "r");
    try { readSync(fd, buffer, 0, length, cache.parsedTo); } finally { closeSync(fd); }
    let start = 0;
    for (let end = buffer.indexOf(0x0a); end >= 0; end = buffer.indexOf(0x0a, start)) {
      const text = buffer.toString("utf8", start, end).replace(/\r$/, "");
      // A damaged line is skipped rather than failing the whole index; unknown images are sent unchanged anyway.
      let record: Json | null = null;
      if (text.trim()) { try { record = JSON.parse(text); } catch { record = null; } }
      if (record) cache.records.push({ offset: cache.parsedTo + start, type: record.type, payload: record.payload ?? {} });
      start = end + 1;
    }
    cache.parsedTo += start;
    cache.size = stat.size;
    cache.mtimeMs = stat.mtimeMs;
    files.set(file, cache);
  }
  return cache.records;
}

// Every rollout segment by id: a thread's first segment uses the thread id itself, later pages are named
// <thread>_<segment>. A fork's history_base points into its parent's segments, so bases are looked up globally.
function allSegments(sessionsDir: string): { segments: Map<string, string>; threadOf: Map<string, string> } {
  const segments = new Map<string, string>();
  const threadOf = new Map<string, string>();
  for (const file of walk(sessionsDir)) {
    const match = SEGMENT_NAME.exec(basename(file));
    if (!match) continue;
    segments.set(match[2] ?? match[1], file);
    threadOf.set(match[2] ?? match[1], match[1]);
  }
  return { segments, threadOf };
}

const baseOf = (file: string): Json | null => (records(file)[0]?.type === "session_meta" ? records(file)[0].payload.history_base ?? null : null);

function effective(segments: Map<string, string>, segmentId: string, endOffset = Number.POSITIVE_INFINITY): Parsed[] {
  const file = segments.get(segmentId);
  if (!file) throw new Error(`rollout segment not found: ${segmentId}`);
  const base = baseOf(file);
  const inherited = base ? effective(segments, base.thread_id, base.end_byte_offset) : [];
  return [...inherited, ...records(file).filter((record) => record.offset < endOffset)];
}

function pixelHash(ref: ImageRef, value: string): string | null {
  if (ref.mime !== "image/png") return null;
  if (!pixelHashes.has(ref.contentId)) {
    try { pixelHashes.set(ref.contentId, decodePng(Buffer.from(value, "base64")).pixelSha256); } catch { pixelHashes.set(ref.contentId, null); }
  }
  return pixelHashes.get(ref.contentId) ?? null;
}

export function imageData(items: Json[], ref: ImageRef): string | null {
  const item = items[ref.item];
  if (ref.part === null) return typeof item?.result === "string" ? item.result : null;
  const url = (item?.content ?? item?.output)?.[ref.part]?.image_url;
  return typeof url === "string" ? url.slice(url.indexOf(",") + 1) : null;
}

export function pixelHashOf(items: Json[], ref: ImageRef): string | null {
  const value = imageData(items, ref);
  return value === null ? null : pixelHash(ref, value);
}

export function buildIndex(threadId: string, history: Parsed[]): ThreadIndex {
  const turnNumbers = new Map<string, number>();
  const items: Json[] = [];
  const activeTurn: Array<string | null> = [];
  let current: string | null = null;
  for (const record of history) {
    if (record.type === "event_msg" && record.payload.type === "task_started" && record.payload.turn_id) {
      current = record.payload.turn_id;
      if (!turnNumbers.has(current!)) turnNumbers.set(current!, turnNumbers.size + 1);
    }
    if (record.type === "response_item") { items.push(record.payload); activeTurn.push(current); }
  }
  const images: IndexedImage[] = [];
  const byKey = new Map<string, IndexedImage>();
  for (const ref of findImages(items)) {
    if (byKey.has(ref.key)) continue;
    const turnId = ref.turnId ?? activeTurn[ref.item];
    const entry: IndexedImage = {
      ...ref,
      id: `IMG-${String(images.length + 1).padStart(3, "0")}`,
      turn: turnId ? turnNumbers.get(turnId) ?? null : null,
      bytes: Math.floor((ref.base64Chars * 3) / 4),
      pixelSha256: pixelHashOf(items, ref),
    };
    images.push(entry);
    byKey.set(ref.key, entry);
  }
  // An image whose own name is unknown (e.g. viewed through a variable path) takes the name of an identical one.
  for (const entry of images) {
    if (entry.name) continue;
    const twin = images.find((other) => other.name && (other.contentId === entry.contentId || (entry.pixelSha256 !== null && other.pixelSha256 === entry.pixelSha256)));
    if (twin) entry.name = twin.name;
  }
  return { threadId, images, byKey, turns: turnNumbers.size };
}

// The first line alone (session_meta can be long), read in chunks without parsing the rest of the file.
function firstLine(file: string): string {
  const fd = openSync(file, "r");
  try {
    const chunks: Buffer[] = [];
    const chunk = Buffer.alloc(64 * 1024);
    for (let position = 0; ; position += chunk.length) {
      const read = readSync(fd, chunk, 0, chunk.length, position);
      if (read <= 0) break;
      const end = chunk.subarray(0, read).indexOf(0x0a);
      chunks.push(Buffer.from(chunk.subarray(0, end >= 0 ? end : read)));
      if (end >= 0 || read < chunk.length) break;
    }
    return Buffer.concat(chunks).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

const origins = new Map<string, { parent: string; at: string } | null>();

// A forked thread's session_meta names the thread it came from and when it was forked. Cached: it never changes.
export function forkOrigin(sessionsDir: string, threadId: string): { parent: string; at: string } | null {
  if (origins.has(threadId)) return origins.get(threadId)!;
  const first = allSegments(sessionsDir).segments.get(threadId);
  // No rollout yet: do not cache, it may appear once the thread starts.
  if (!first) return null;
  let origin: { parent: string; at: string } | null = null;
  try {
    const meta = JSON.parse(firstLine(first));
    if (meta.type === "session_meta" && meta.payload?.forked_from_id) origin = { parent: meta.payload.forked_from_id, at: meta.payload.timestamp ?? "" };
  } catch { /* unreadable first line: treat as not a fork */ }
  origins.set(threadId, origin);
  return origin;
}

// The thread's model-visible history records, following paginated segments back through history_base.
export function readThreadHistory(sessionsDir: string, threadId: string): Parsed[] {
  const { segments, threadOf } = allSegments(sessionsDir);
  const own = [...segments.keys()].filter((id) => threadOf.get(id) === threadId);
  if (!own.length) throw new Error(`no rollout found for thread ${threadId}`);
  const bases = new Set(own.map((id) => baseOf(segments.get(id)!)?.thread_id).filter(Boolean));
  const heads = own.filter((id) => !bases.has(id));
  if (heads.length !== 1) throw new Error(`expected one latest rollout segment for ${threadId}, found ${heads.length}`);
  return effective(segments, heads[0]);
}

export function loadThreadIndex(sessionsDir: string, threadId: string): ThreadIndex {
  return buildIndex(threadId, readThreadHistory(sessionsDir, threadId));
}
