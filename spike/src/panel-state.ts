// Purpose: P3-3 — what the panel shows for one thread: every image occurrence with its state, the ids the model asked
// for in its latest reply, and the engine's statistics of the latest request. Also applies check/uncheck actions.
// Input: thread id, the sessions directory (rollouts are only read) and the tool's data directory.
// Output: PanelState as plain JSON; selection changes are written to <data dir>/selection/.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { dataDir, requestStatsDirOf, selectionDirOf } from "./paths.ts";
import { effectiveSelection, writeSelection } from "./selection.ts";
import { buildIndex, imageData, readThreadHistory, type IndexedImage, type ThreadIndex } from "./thread-index.ts";
import { pngThumbnail } from "./thumbnail.ts";

type Json = Record<string, any>;
type Record_ = { type: string; payload: Json };
export type PanelImage = {
  id: string; kind: string; name: string | null; label: string | null; turn: number | null;
  width: number | null; height: number | null; bytes: number;
  sameAs: string[]; checked: boolean; replaceable: boolean; requested: boolean;
};
export type PanelState = {
  threadId: string; turns: number; images: PanelImage[]; requested: string[];
  totals: { images: number; unchecked: number; checkedBytes: number; allBytes: number };
  lastRequest: Json | null;
};
export type PanelOptions = { sessionsDir: string; dataRoot?: string };

// "需要 IMG-004" or a list right after it ("需要 IMG-004、IMG-002 和 IMG-007"); a full stop ends the list.
const ASKED = [
  /需要((?:\s*[“"'「]?\s*IMG-\d{3,}\s*[”"'」]?\s*(?:[、，,/]|以及|和|与|及)?)+)/g,
  /\bneeds?((?:\s*IMG-\d{3,}\s*(?:,|and)?)+)/gi,
];

// Ids the model asked for ("需要 IMG-003") in its latest reply; a turn still running falls back to the one before.
export function requestedIds(history: Record_[]): string[] {
  let current: string[] = [];
  let previous: string[] = [];
  for (const record of history) {
    if (record.type === "event_msg" && record.payload.type === "task_started") {
      if (current.length) previous = current;
      current = [];
    }
    if (record.type === "response_item" && record.payload.type === "message" && record.payload.role === "assistant") {
      for (const part of record.payload.content ?? []) if (typeof part?.text === "string") current.push(part.text);
    }
  }
  const ids = new Set<string>();
  for (const text of current.length ? current : previous) {
    for (const pattern of ASKED) for (const match of text.matchAll(pattern)) for (const id of match[1].matchAll(/IMG-\d{3,}/gi)) ids.add(id[0].toUpperCase());
  }
  return [...ids];
}

export function sameContent(index: ThreadIndex, image: IndexedImage): string[] {
  return index.images
    .filter((other) => other !== image && (other.contentId === image.contentId || (image.pixelSha256 !== null && other.pixelSha256 === image.pixelSha256)))
    .map((other) => other.id);
}

export function panelState(threadId: string, history: Record_[], index: ThreadIndex, unchecked: Set<string>, lastRequest: Json | null): PanelState {
  const requested = requestedIds(history);
  const images = index.images.map((image): PanelImage => ({
    id: image.id, kind: image.kind, name: image.name, label: image.label, turn: image.turn,
    width: image.width, height: image.height, bytes: image.bytes,
    sameAs: sameContent(index, image),
    checked: !unchecked.has(image.key),
    replaceable: image.replaceable,
    requested: requested.includes(image.id),
  }));
  return {
    threadId, turns: index.turns, images, requested,
    totals: {
      images: images.length,
      unchecked: images.filter((image) => !image.checked).length,
      checkedBytes: images.filter((image) => image.checked).reduce((sum, image) => sum + image.bytes, 0),
      allBytes: images.reduce((sum, image) => sum + image.bytes, 0),
    },
    lastRequest,
  };
}

function load(threadId: string, options: PanelOptions) {
  const root = options.dataRoot ?? dataDir();
  const history = readThreadHistory(options.sessionsDir, threadId);
  const index = buildIndex(threadId, history);
  const selection = effectiveSelection(threadId, options.sessionsDir, selectionDirOf(root));
  const statsFile = join(requestStatsDirOf(root), `${threadId}.json`);
  const lastRequest = existsSync(statsFile) ? JSON.parse(readFileSync(statsFile, "utf8")) : null;
  return { root, history, index, selection, lastRequest };
}

export function loadPanelState(threadId: string, options: PanelOptions): PanelState {
  const { history, index, selection, lastRequest } = load(threadId, options);
  return panelState(threadId, history, index, new Set(Object.keys(selection.unchecked)), lastRequest);
}

export function applySelection(threadId: string, change: { uncheck?: string[]; check?: string[]; checkAll?: boolean }, options: PanelOptions): PanelState {
  const { root, history, index, selection, lastRequest } = load(threadId, options);
  const unchecked = change.checkAll ? {} : { ...selection.unchecked };
  const byId = new Map(index.images.map((image) => [image.id, image]));
  for (const id of change.uncheck ?? []) {
    const image = byId.get(id);
    if (!image) throw new Error(`${id} is not an image of this thread`);
    if (!image.replaceable) throw new Error(`${id} cannot be unchecked (hosted image generation result)`);
    unchecked[image.key] = { id, at: new Date().toISOString() };
  }
  for (const id of change.check ?? []) {
    const image = byId.get(id);
    if (!image) throw new Error(`${id} is not an image of this thread`);
    delete unchecked[image.key];
  }
  writeSelection({ threadId, unchecked }, selectionDirOf(root));
  return panelState(threadId, history, index, new Set(Object.keys(unchecked)), lastRequest);
}

export function thumbnailFor(threadId: string, id: string, maxSide: number, options: PanelOptions): { id: string; dataUrl: string | null } {
  const history = readThreadHistory(options.sessionsDir, threadId);
  const index = buildIndex(threadId, history);
  const image = index.images.find((candidate) => candidate.id === id);
  if (!image) throw new Error(`${id} is not an image of this thread`);
  const items = history.filter((record) => record.type === "response_item").map((record) => record.payload);
  const data = imageData(items, image);
  return { id, dataUrl: data && image.mime === "image/png" ? pngThumbnail(data, maxSide) : null };
}
