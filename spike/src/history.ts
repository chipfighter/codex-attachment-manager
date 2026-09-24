// Purpose: read a thread's effective model-visible history from paginated rollout segments (read-only)
// and estimate how many bytes of history a model request carries.
// Input: the sessions directory and a thread or segment id. Output: records and byte estimates (in memory).

import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

type Json = Record<string, any>;
export type RolloutRecord = { file: string; line: number; offset: number; ordinal: number | null; type: string; payload: Json };

function walk(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = join(directory, entry.name);
    return entry.isDirectory() ? walk(full) : entry.isFile() ? [full] : [];
  });
}

// A segment id is the UUID suffix after the thread id in the file name; the first segment uses the thread id itself.
export function indexSegments(sessionsDir: string): Map<string, string> {
  const segments = new Map<string, string>();
  for (const file of walk(sessionsDir)) {
    const match = /rollout-[0-9T:-]+-([0-9a-f-]{36})(?:_([0-9a-f-]{36}))?\.jsonl$/.exec(basename(file));
    if (match) segments.set(match[2] ?? match[1], file);
  }
  return segments;
}

function ownRecords(file: string, endOffset: number): { meta: Json; records: RolloutRecord[] } {
  const buffer = readFileSync(file);
  const records: RolloutRecord[] = [];
  let meta: Json = {};
  let offset = 0;
  let line = 0;
  while (offset < buffer.length && offset < endOffset) {
    let end = buffer.indexOf(0x0a, offset);
    if (end < 0) end = buffer.length;
    line++;
    const text = buffer.toString("utf8", offset, end).replace(/\r$/, "");
    if (text.trim()) {
      const record = JSON.parse(text);
      if (record.type === "session_meta" && line === 1) meta = record.payload ?? {};
      records.push({ file, line, offset, ordinal: record.ordinal ?? null, type: record.type, payload: record.payload ?? {} });
    }
    offset = end + 1;
  }
  return { meta, records };
}

// Effective history = the base segment's records before history_base.end_byte_offset (recursively) + this segment's records.
export function effectiveRecords(segments: Map<string, string>, segmentId: string, endOffset = Number.POSITIVE_INFINITY): RolloutRecord[] {
  const file = segments.get(segmentId);
  if (!file) throw new Error(`rollout segment not found: ${segmentId}`);
  const { meta, records } = ownRecords(file, endOffset);
  const base = meta.history_base;
  const inherited = base ? effectiveRecords(segments, base.thread_id, base.end_byte_offset) : [];
  return [...inherited, ...records];
}

// The newest segment of a thread is the one no other segment of that thread uses as its base.
export function latestSegment(segments: Map<string, string>, threadId: string): string {
  const own = [...segments.entries()].filter(([, file]) => basename(file).includes(threadId));
  const bases = new Set<string>();
  for (const [, file] of own) {
    const first = readFileSync(file, "utf8").split("\n", 1)[0];
    const base = JSON.parse(first).payload?.history_base?.thread_id;
    if (base) bases.add(base);
  }
  const heads = own.filter(([id]) => !bases.has(id)).map(([id]) => id);
  if (heads.length !== 1) throw new Error(`expected one latest segment for ${threadId}, found ${heads.length}`);
  return heads[0];
}

export type InlineImage = { sha256: string; bytes: number; dataUrlChars: number; record: RolloutRecord };

export function inlineImages(records: RolloutRecord[]): InlineImage[] {
  const images: InlineImage[] = [];
  for (const record of records) {
    if (record.type !== "response_item") continue;
    const parts = Array.isArray(record.payload.content) ? record.payload.content : Array.isArray(record.payload.output) ? record.payload.output : [];
    for (const part of parts) {
      const url = part?.image_url;
      const match = typeof url === "string" ? /^data:[^;,]+;base64,(.+)$/s.exec(url) : null;
      if (!match) continue;
      const bytes = Buffer.from(match[1], "base64");
      images.push({ sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length, dataUrlChars: url.length, record });
    }
  }
  return images;
}

// Bytes of the history items a request would carry: every response_item payload serialized as UTF-8 JSON.
export function historyBytes(records: RolloutRecord[]): { items: number; bytes: number } {
  let bytes = 0;
  let items = 0;
  for (const record of records) {
    if (record.type !== "response_item") continue;
    items++;
    bytes += Buffer.byteLength(JSON.stringify(record.payload), "utf8");
  }
  return { items, bytes };
}
