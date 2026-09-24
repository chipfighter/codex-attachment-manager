// Purpose: T7 prerequisite — check that the rollout-based request estimate matches real request sizes
// that Codex logged (pre_compression_bytes) for the sample threads.
// Input: --sessions <dir>; sample thread ids and logged sizes come from local/sample.json (never committed).
// Output: local/t7-calibration.json and a console table.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { effectiveRecords, historyBytes, indexSegments, inlineImages, latestSegment, type RolloutRecord } from "./history.ts";

type CalibrationCase = { name: string; thread: "original" | "fork"; segment: "fork" | "latest"; lastLine: number | null; logged: number };
const localRoot = join(resolve(dirname(fileURLToPath(import.meta.url)), "../.."), "local");

function argument(name: string): string {
  const index = process.argv.indexOf(name);
  if (index < 0 || !process.argv[index + 1]) throw new Error(`missing ${name}`);
  return process.argv[index + 1];
}

// Keep inherited records plus the named segment's records up to and including `lastLine`.
function upTo(records: RolloutRecord[], segmentFileSuffix: string, lastLine: number): RolloutRecord[] {
  return records.filter((record) => !record.file.endsWith(segmentFileSuffix) || record.line <= lastLine);
}

function main(): void {
  const sample = JSON.parse(readFileSync(join(localRoot, "sample.json"), "utf8"));
  const threads: Record<string, string> = { original: sample.originalThreadId, fork: sample.forkThreadId };
  const segments = indexSegments(argument("--sessions"));
  const rows = (sample.calibration as CalibrationCase[]).map(({ name, thread, segment, lastLine, logged }) => {
    const threadId = threads[thread];
    const segmentId = segment === "latest" ? latestSegment(segments, threadId) : threadId;
    const all = effectiveRecords(segments, segmentId);
    const records = lastLine === null ? all : upTo(all, `${threadId}.jsonl`, lastLine);
    const { items, bytes } = historyBytes(records);
    const images = inlineImages(records);
    return {
      name,
      logged,
      historyItems: items,
      historyBytes: bytes,
      overheadBytes: logged - bytes,
      ratio: Number((bytes / logged).toFixed(4)),
      inlineImages: images.length,
      inlineImageDataUrlBytes: images.reduce((sum, image) => sum + image.dataUrlChars, 0),
    };
  });
  writeFileSync(join(localRoot, "t7-calibration.json"), JSON.stringify({ createdAt: new Date().toISOString(), rows }, null, 2));
  console.table(rows);
}

main();
