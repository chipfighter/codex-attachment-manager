// Purpose: T7 — measure the rebuilt thread: which images its history carries and how large each request was,
// using the rollout-based estimate calibrated against real logged request sizes (see t7-calibrate.ts).
// Input: --sessions <dir>; the rebuilt thread comes from local/t4-rebuild.json, later attachments from local/turn-*.json,
// assets from local/assets.json and the baseline from local/sample.json.
// Output: local/t7-measure.json and a console table.

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { effectiveRecords, historyBytes, indexSegments, inlineImages, latestSegment, type RolloutRecord } from "./history.ts";

type Json = Record<string, any>;
const localRoot = join(resolve(dirname(fileURLToPath(import.meta.url)), "../.."), "local");

function argument(name: string): string {
  const index = process.argv.indexOf(name);
  if (index < 0 || !process.argv[index + 1]) throw new Error(`missing ${name}`);
  return process.argv[index + 1];
}

const isModelOutput = (record: RolloutRecord) =>
  record.type === "response_item" &&
  (record.payload.type === "reasoning" || (record.payload.type === "message" && record.payload.role === "assistant") || /call$/.test(record.payload.type ?? ""));

function main(): void {
  const rebuilt: Json = JSON.parse(readFileSync(join(localRoot, "t4-rebuild.json"), "utf8"));
  const inventory: Json = JSON.parse(readFileSync(join(localRoot, "assets.json"), "utf8"));
  const assetByHash = new Map<string, string>();
  for (const asset of inventory.assets) for (const hash of asset.byteHashes) assetByHash.set(hash, asset.assetId);

  const segments = indexSegments(argument("--sessions"));
  const records = effectiveRecords(segments, latestSegment(segments, rebuilt.threadId));

  // First request of each turn = every history item recorded before the model's first output in that turn.
  const requests: Array<{ turn: number; historyItems: number; historyBytes: number; inlineImages: string[] }> = [];
  let turn = 0;
  let awaitingFirstOutput = false;
  for (const [index, record] of records.entries()) {
    if (record.type === "event_msg" && record.payload.type === "task_started") { turn++; awaitingFirstOutput = true; continue; }
    if (awaitingFirstOutput && isModelOutput(record)) {
      const before = records.slice(0, index);
      const { items, bytes } = historyBytes(before);
      requests.push({ turn, historyItems: items, historyBytes: bytes, inlineImages: inlineImages(before).map((image) => assetByHash.get(image.sha256) ?? `new:${image.sha256.slice(0, 8)}`) });
      awaitingFirstOutput = false;
    }
  }
  const final = historyBytes(records);
  const images = inlineImages(records).map((image) => ({ asset: assetByHash.get(image.sha256) ?? "not in index (resized or generated)", sha256: image.sha256.slice(0, 12), bytes: image.bytes, dataUrlBytes: image.dataUrlChars }));
  const carried = new Set(images.map((image) => image.asset));
  // Every asset ever attached: the rebuild selection plus any later turn's attachments on this thread.
  const attached = new Set<string>(rebuilt.selected);
  for (const file of readdirSync(localRoot).filter((name) => /^turn-.+\.json$/.test(name))) {
    const turn: Json = JSON.parse(readFileSync(join(localRoot, file), "utf8"));
    if (turn.threadId === rebuilt.threadId) for (const id of turn.attach ?? []) attached.add(id);
  }
  const neverSelected = inventory.assets.map((asset: Json) => asset.assetId).filter((id: string) => !attached.has(id));
  const sample: Json = JSON.parse(readFileSync(join(localRoot, "sample.json"), "utf8"));
  const result = {
    createdAt: new Date().toISOString(),
    threadId: rebuilt.threadId,
    requests,
    finalHistory: { items: final.items, bytes: final.bytes },
    inlineImages: images,
    neverSelected,
    unselectedCarried: neverSelected.filter((id: string) => carried.has(id)),
    attached: [...attached],
    baselineLoggedBytes: Math.max(...sample.calibration.map((c: Json) => c.logged)),
  };
  writeFileSync(join(localRoot, "t7-measure.json"), JSON.stringify(result, null, 2));
  console.table(requests.map((r) => ({ ...r, inlineImages: r.inlineImages.join(" "), vsBaseline: `${((r.historyBytes / result.baselineLoggedBytes) * 100).toFixed(1)}%` })));
  console.table(images);
  console.log(JSON.stringify({ finalHistory: result.finalHistory, neverSelected, unselectedCarried: result.unselectedCarried }));
}

main();
