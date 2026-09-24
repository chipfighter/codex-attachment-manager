// Purpose: P3-3 — what the panel shows for one thread: every image occurrence with its state, the ids the model asked
// for in its latest reply, and the engine's statistics of the latest request. Also applies check/uncheck actions.
// P4 — serves each image for the panel's thumbnails and previews, and the inputs of its "next message" estimate:
// the last full request as a size baseline, which images it carried, and whether the engine could not rewrite it.
// Input: thread id, the sessions directory (rollouts are only read) and the tool's data directory.
// Output: PanelState as plain JSON; selection changes are written to <data dir>/selection/.

import { dataDir, requestStatsDirOf, selectionDirOf } from "./paths.ts";
import { readRequestStats, type RequestStats } from "./request-stats.ts";
import { effectiveSelection, writeSelection } from "./selection.ts";
import { buildIndex, imageData, readThreadHistory, type IndexedImage, type ThreadIndex } from "./thread-index.ts";
import { pngThumbnail } from "./thumbnail.ts";

type Json = Record<string, any>;
type Record_ = { type: string; payload: Json };
export type PanelImage = {
  id: string; kind: string; name: string | null; label: string | null; turn: number | null;
  width: number | null; height: number | null; bytes: number; base64Chars: number;
  sameAs: string[]; checked: boolean; replaceable: boolean; requested: boolean;
  // Whether the last full request carried it (null: no such request recorded yet), and whether the next one will
  // (carried last time, or added since; images compacted out of the history will not come back).
  inLastRequest: boolean | null; inNextRequest: boolean;
};
export type SendInfo = {
  // The last full HTTP request as Codex built it, before any rewrite: the baseline of the estimate.
  baseline: { at: string; bytes: number } | null;
  // What the engine sent for that request.
  last: { at: string; bytesBefore: number; bytesAfter: number; replaced: number; skipped: boolean } | null;
  notice: { kind: "skipped"; at: string; reason: string } | { kind: "websocket"; at: string } | null;
};
export type PanelState = {
  threadId: string; turns: number; images: PanelImage[]; requested: string[];
  totals: { images: number; unchecked: number; checkedBytes: number; allBytes: number };
  send: SendInfo;
};

// The engine's reasons for forwarding a request unchanged, in the user's words.
const SKIP_REASONS: Array<[RegExp, string]> = [
  [/^undecodable body/, "请求内容无法解压"],
  [/^unparsable body/, "请求内容无法解析"],
  [/^no input array/, "请求的格式和预期不同"],
  [/^integer beyond/, "请求里有超大整数，改写会改变它的值"],
  [/^thread index/, "读取这个任务的记录失败"],
];

export function sendInfo(stats: RequestStats | null): SendInfo {
  const latest = stats?.latest ?? null;
  const http = stats?.lastHttp ?? null;
  const bytes = typeof http?.decodedBytes === "number" ? http.decodedBytes : null;
  const rewrite = http?.rewrite ?? null;
  let notice: SendInfo["notice"] = null;
  if (latest?.transport === "websocket" && (latest.event === "active-while-unchecked" || latest.activeWhileUnchecked)) notice = { kind: "websocket", at: latest.at };
  else if (latest?.transport === "http" && rewrite?.skipped) {
    notice = { kind: "skipped", at: http!.at, reason: SKIP_REASONS.find(([pattern]) => pattern.test(rewrite.skipped))?.[1] ?? "改写时出错" };
  }
  return {
    baseline: http && bytes !== null && http.imageSizes ? { at: http.at, bytes } : null,
    last: http && bytes !== null ? { at: http.at, bytesBefore: bytes, bytesAfter: rewrite?.decodedAfter ?? bytes, replaced: rewrite?.replaced?.length ?? 0, skipped: !!rewrite?.skipped } : null,
    notice,
  };
}
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

export function panelState(threadId: string, history: Record_[], index: ThreadIndex, unchecked: Set<string>, stats: RequestStats | null): PanelState {
  const requested = requestedIds(history);
  const carried: Record<string, number> | null = stats?.lastHttp?.imageSizes ?? null;
  // Images after the last one that request carried, or from a later turn, were added since and go out next time.
  const lastCarried = carried ? index.images.reduce((last, image, position) => (image.key in carried ? position : last), -1) : -1;
  const lastTurn = stats?.lastHttp?.turnId ? index.turnNumbers.get(stats.lastHttp.turnId) ?? null : null;
  const images = index.images.map((image, position): PanelImage => {
    const inLast = carried ? image.key in carried : null;
    return {
      id: image.id, kind: image.kind, name: image.name, label: image.label, turn: image.turn,
      width: image.width, height: image.height, bytes: image.bytes, base64Chars: image.base64Chars,
      sameAs: sameContent(index, image),
      checked: !unchecked.has(image.key),
      replaceable: image.replaceable,
      requested: requested.includes(image.id),
      inLastRequest: inLast,
      inNextRequest: inLast !== false || position > lastCarried || (lastTurn !== null && image.turn !== null && image.turn > lastTurn),
    };
  });
  return {
    threadId, turns: index.turns, images, requested,
    totals: {
      images: images.length,
      unchecked: images.filter((image) => !image.checked).length,
      checkedBytes: images.filter((image) => image.checked).reduce((sum, image) => sum + image.bytes, 0),
      allBytes: images.reduce((sum, image) => sum + image.bytes, 0),
    },
    send: sendInfo(stats),
  };
}

// A thread with no rollout yet (new, or the panel opened outside a thread) simply has no images.
function historyOf(threadId: string, sessionsDir: string): Record_[] {
  try {
    return readThreadHistory(sessionsDir, threadId);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("no rollout found")) return [];
    throw error;
  }
}

function load(threadId: string, options: PanelOptions) {
  const root = options.dataRoot ?? dataDir();
  const history = historyOf(threadId, options.sessionsDir);
  const index = buildIndex(threadId, history);
  const selection = effectiveSelection(threadId, options.sessionsDir, selectionDirOf(root));
  const stats = readRequestStats(threadId, requestStatsDirOf(root));
  return { root, history, index, selection, stats };
}

export function loadPanelState(threadId: string, options: PanelOptions): PanelState {
  const { history, index, selection, stats } = load(threadId, options);
  return panelState(threadId, history, index, new Set(Object.keys(selection.unchecked)), stats);
}

export function applySelection(threadId: string, change: { uncheck?: string[]; check?: string[]; checkAll?: boolean }, options: PanelOptions): PanelState {
  const { root, history, index, selection, stats } = load(threadId, options);
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
  return panelState(threadId, history, index, new Set(Object.keys(unchecked)), stats);
}

// One image for the panel: a PNG larger than maxSide is scaled down; smaller PNGs and other formats (which the
// browser scales itself) are passed through as they are.
export function imageFor(threadId: string, id: string, maxSide: number, options: PanelOptions): { id: string; dataUrl: string | null } {
  const history = historyOf(threadId, options.sessionsDir);
  const index = buildIndex(threadId, history);
  const image = index.images.find((candidate) => candidate.id === id);
  if (!image) throw new Error(`${id} is not an image of this thread`);
  const items = history.filter((record) => record.type === "response_item").map((record) => record.payload);
  const data = imageData(items, image);
  if (!data || !image.mime?.startsWith("image/")) return { id, dataUrl: null };
  const original = `data:${image.mime};base64,${data}`;
  const large = image.mime === "image/png" && Math.max(image.width ?? 0, image.height ?? 0) > maxSide;
  // A PNG our decoder cannot read (e.g. interlaced) is still shown, just not scaled down first.
  return { id, dataUrl: large ? pngThumbnail(data, maxSide) ?? original : original };
}
