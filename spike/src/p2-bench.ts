// Purpose: P2 — measure on this machine how long content fingerprints, the thread index and a full request rewrite
// take for a real thread. The rollout is only read; nothing but timings and counts is written.
// Input: --thread <id> [--label name]. Output: local/p2/bench-<label>.json and a console summary.

import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";
import { codexHome } from "../../plugin/src/codexconfig.ts";
import { findImages } from "../../plugin/src/images.ts";
import { decodePng } from "../../plugin/src/png.ts";
import { hasUnsafeInteger, rewriteBody } from "../../plugin/src/proxy.ts";
import { rewriteItems } from "../../plugin/src/rewrite.ts";
import { writeSelection } from "../../plugin/src/selection.ts";
import { imageData, loadThreadIndex, readThreadHistory } from "../../plugin/src/thread-index.ts";

type Json = Record<string, any>;
const localRoot = join(resolve(dirname(fileURLToPath(import.meta.url)), "../.."), "local");
const round = (ms: number) => Math.round(ms * 10) / 10;

function time<T>(fn: () => T): [T, number] {
  const started = performance.now();
  const result = fn();
  return [result, round(performance.now() - started)];
}

function main(): void {
  const option = (name: string, fallback?: string) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : fallback);
  const threadId = option("--thread");
  if (!threadId) throw new Error("usage: p2-bench.ts --thread <id> [--label name]");
  const label = option("--label", "default")!;
  const sessions = join(codexHome(), "sessions");

  const [index, indexColdMs] = time(() => loadThreadIndex(sessions, threadId));
  const [, indexWarmMs] = time(() => loadThreadIndex(sessions, threadId));
  const items: Json[] = readThreadHistory(sessions, threadId).filter((record) => record.type === "response_item").map((record) => record.payload);

  // Fresh per-image costs, outside every cache.
  const perImage = findImages(items).map((ref) => {
    const value = imageData(items, ref) ?? "";
    const [, sha256Ms] = time(() => createHash("sha256").update(value).digest("hex"));
    let pixelMs: number | null = null;
    if (ref.mime === "image/png") [, pixelMs] = time(() => decodePng(Buffer.from(value, "base64")).pixelSha256);
    return { size: ref.width && ref.height ? `${ref.width}x${ref.height}` : null, mb: round(ref.base64Chars / 1e6), sha256Ms, pixelMs };
  });

  // A request carrying the whole history, the way Codex sends it over HTTP, with the first image unchecked.
  const text = JSON.stringify({ model: "bench", input: items, stream: true });
  const [original, codexCompressMs] = time(() => zlib.zstdCompressSync(Buffer.from(text)));
  const selections = mkdtempSync(join(tmpdir(), "cam-bench-"));
  const first = index.images.find((image) => image.replaceable)!;
  writeSelection({ threadId, unchecked: { [first.key]: { id: first.id, at: new Date().toISOString() } } }, selections);
  const steps: Json = {};
  const [decoded, decompressMs] = time(() => zlib.zstdDecompressSync(original));
  steps.decompressMs = decompressMs;
  const [json, parseMs] = time(() => JSON.parse(decoded.toString("utf8")));
  steps.parseMs = parseMs;
  [, steps.unsafeIntegerScanMs] = time(() => hasUnsafeInteger(text));
  [, steps.findImagesMs] = time(() => findImages(json.input));
  const byKey = index.byKey;
  const [rewritten, replaceMs] = time(() => rewriteItems(json.input, (ref) => byKey.get(ref.key), new Set([first.key]), (ref) => byKey.get(ref.key)?.pixelSha256 ?? null));
  steps.replaceMs = replaceMs;
  json.input = rewritten.items;
  const [next, stringifyMs] = time(() => Buffer.from(JSON.stringify(json)));
  steps.stringifyMs = stringifyMs;
  [, steps.compressMs] = time(() => zlib.zstdCompressSync(next));
  const [out, rewriteBodyMs] = time(() => rewriteBody(original, "zstd", threadId, sessions, selections));
  rmSync(selections, { recursive: true, force: true });

  const result = {
    createdAt: new Date().toISOString(),
    images: index.images.length,
    distinctContents: new Set(index.images.map((image) => image.contentId)).size,
    indexColdMs,
    indexWarmMs,
    perImage,
    request: { decodedMB: round(text.length / 1e6), zstdMB: round(original.length / 1e6), codexCompressMs, afterZstdMB: round(out.body.length / 1e6), replaced: out.report.replaced?.map((r: Json) => r.id), skipped: out.report.skipped ?? null },
    rewriteSteps: steps,
    rewriteBodyMs,
  };
  mkdirSync(join(localRoot, "p2"), { recursive: true });
  writeFileSync(join(localRoot, "p2", `bench-${label}.json`), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
}

main();
