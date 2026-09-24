// Purpose: match indexed images to read-only local originals and cache inline-only copies.
// Input: local/assets.json plus --project and --generated image directories.
// Output: local/matches.json, local/matches.md, and exact inline copies under local/cache/.

import { createHash } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { decodePng, type DecodedPng } from "./png.ts";

type Json = Record<string, any>;
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const localRoot = join(repoRoot, "local");

function argument(name: string): string {
  const i = process.argv.indexOf(name);
  if (i < 0 || !process.argv[i + 1]) throw new Error(`missing ${name}`);
  return resolve(process.argv[i + 1]);
}

function walk(directory: string): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = join(directory, entry.name);
    return entry.isDirectory() ? walk(full) : entry.isFile() ? [full] : [];
  });
}

async function sha256File(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

async function inlineImage(occurrence: Json, sourceFiles: Json[]): Promise<Buffer> {
  const source = sourceFiles.find((entry) => basename(entry.path) === occurrence.rolloutFile);
  if (!source) throw new Error(`missing rollout source for ${occurrence.assetId}`);
  let number = 0;
  const lines = createInterface({ input: createReadStream(source.path, { encoding: "utf8" }), crlfDelay: Infinity });
  for await (const line of lines) {
    if (++number !== occurrence.line) continue;
    const item = JSON.parse(line).payload;
    const parts = Array.isArray(item.content) ? item.content : item.output;
    const image = parts?.[occurrence.contentIndex];
    const match = /^data:[^;,]+;base64,(.+)$/s.exec(image?.image_url ?? image?.url ?? "");
    if (!match) throw new Error(`inline image missing for ${occurrence.assetId}`);
    const bytes = Buffer.from(match[1], "base64");
    if (createHash("sha256").update(bytes).digest("hex") !== occurrence.byteSha256) {
      throw new Error(`inline image hash changed for ${occurrence.assetId}`);
    }
    lines.close();
    return bytes;
  }
  throw new Error(`rollout line missing for ${occurrence.assetId}`);
}

function resizedSimilarity(source: DecodedPng, target: DecodedPng): number {
  let difference = 0;
  const sourcePixels = source.pixels;
  const targetPixels = target.pixels;
  for (let y = 0; y < target.height; y++) {
    const sy = Math.max(0, Math.min(source.height - 1, (y + 0.5) * source.height / target.height - 0.5));
    const y0 = Math.floor(sy), y1 = Math.min(source.height - 1, y0 + 1), fy = sy - y0;
    for (let x = 0; x < target.width; x++) {
      const sx = Math.max(0, Math.min(source.width - 1, (x + 0.5) * source.width / target.width - 0.5));
      const x0 = Math.floor(sx), x1 = Math.min(source.width - 1, x0 + 1), fx = sx - x0;
      const dest = (y * target.width + x) * 4;
      for (let channel = 0; channel < 3; channel++) {
        const a = sourcePixels[(y0 * source.width + x0) * 4 + channel];
        const b = sourcePixels[(y0 * source.width + x1) * 4 + channel];
        const c = sourcePixels[(y1 * source.width + x0) * 4 + channel];
        const d = sourcePixels[(y1 * source.width + x1) * 4 + channel];
        const interpolated = (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
        difference += Math.abs(interpolated - targetPixels[dest + channel]);
      }
    }
  }
  return 1 - difference / (target.width * target.height * 3 * 255);
}

async function main(): Promise<void> {
  const project = argument("--project");
  const generated = argument("--generated");
  const inventory: Json = JSON.parse(readFileSync(join(localRoot, "assets.json"), "utf8"));
  const candidateMap = new Map<string, { path: string; sources: string[] }>();
  for (const [source, files] of [
    ["project", walk(project)],
    ["generated_images", walk(generated)],
    ["known_path", inventory.occurrences.map((item: Json) => item.knownLocalPath).filter(Boolean)],
  ] as Array<[string, string[]]>) {
    for (const file of files) {
      if (!existsSync(file) || !/\.(png|jpg|jpeg|webp)$/i.test(extname(file))) continue;
      const key = resolve(file).toLowerCase();
      let candidate = candidateMap.get(key);
      if (!candidate) {
        candidate = { path: resolve(file), sources: [] };
        candidateMap.set(key, candidate);
      }
      if (!candidate.sources.includes(source)) candidate.sources.push(source);
    }
  }

  const candidates = [];
  for (const candidate of candidateMap.values()) {
    candidates.push({ ...candidate, bytes: statSync(candidate.path).size, byteSha256: await sha256File(candidate.path) });
  }
  const matches = [];
  const realFileHashesBefore = new Map<string, string>();
  mkdirSync(join(localRoot, "cache"), { recursive: true });
  for (const asset of inventory.assets) {
    const first: Json = inventory.occurrences.find((item: Json) => item.assetId === asset.assetId);
    const exact = candidates.filter((candidate) => asset.byteHashes.includes(candidate.byteSha256));
    const preferred = exact.find((candidate) => candidate.sources.includes("project"))
      ?? exact.find((candidate) => candidate.sources.includes("generated_images"))
      ?? exact[0];
    const record: Json = { assetId: asset.assetId, exactMatches: exact, attachmentPath: null, attachmentKind: null, resizedCandidate: null };
    if (preferred) {
      record.attachmentPath = preferred.path;
      record.attachmentKind = "exact_local_file";
      realFileHashesBefore.set(preferred.path, preferred.byteSha256);
    } else {
      const inline = await inlineImage(first, inventory.sourceFiles);
      const cachePath = join(localRoot, "cache", `${asset.assetId}.png`);
      if (existsSync(cachePath)) {
        if (await sha256File(cachePath) !== first.byteSha256) throw new Error(`existing cache differs for ${asset.assetId}`);
      } else {
        writeFileSync(cachePath, inline, { flag: "wx" });
      }
      record.attachmentPath = cachePath;
      record.attachmentKind = "exact_inline_cache";
      const known = candidates.find((candidate) => candidate.path.toLowerCase() === resolve(first.knownLocalPath ?? "").toLowerCase());
      if (known?.path.toLowerCase().endsWith(".png")) {
        const source = decodePng(readFileSync(known.path));
        const target = decodePng(inline);
        const similarity = resizedSimilarity(source, target);
        record.resizedCandidate = {
          path: known.path,
          sourceDimensions: [source.width, source.height],
          targetDimensions: [target.width, target.height],
          similarity: Number(similarity.toFixed(6)),
          status: "待确认",
        };
        realFileHashesBefore.set(known.path, known.byteSha256);
      }
    }
    matches.push(record);
  }
  const realFilesUnchanged = [];
  for (const [file, beforeSha256] of realFileHashesBefore) {
    const afterSha256 = await sha256File(file);
    realFilesUnchanged.push({ path: file, beforeSha256, afterSha256, unchanged: beforeSha256 === afterSha256 });
  }
  const report = {
    createdAt: new Date().toISOString(),
    candidateFilesScanned: candidates.length,
    exactLocalFiles: matches.filter((item) => item.attachmentKind === "exact_local_file").length,
    exactInlineCaches: matches.filter((item) => item.attachmentKind === "exact_inline_cache").length,
    resizedCandidatesPending: matches.filter((item) => item.resizedCandidate).length,
    realFilesUnchanged,
    allRealFilesUnchanged: realFilesUnchanged.every((item) => item.unchanged),
    matches,
  };
  writeFileSync(join(localRoot, "matches.json"), JSON.stringify(report, null, 2));
  const rows = matches.map((item) => `| ${item.assetId} | ${item.attachmentKind} | ${item.attachmentPath} | ${item.exactMatches.length} | ${item.resizedCandidate ? `${item.resizedCandidate.similarity}（待确认）` : "—"} |`);
  writeFileSync(join(localRoot, "matches.md"), [
    "# 阶段 0 磁盘素材匹配（仅本机）", "",
    `候选文件：${candidates.length}；精确原件：${report.exactLocalFiles}；内联缓存：${report.exactInlineCaches}；缩放候选：${report.resizedCandidatesPending}；真实文件哈希不变：${report.allRealFilesUnchanged}`, "",
    "| 素材 | 可用附件来源 | 路径 | 精确副本数 | 缩放相似度 |",
    "| --- | --- | --- | ---: | --- |", ...rows, "",
  ].join("\n"));
  console.log(JSON.stringify({ candidateFilesScanned: report.candidateFilesScanned, exactLocalFiles: report.exactLocalFiles, exactInlineCaches: report.exactInlineCaches, resizedCandidatesPending: report.resizedCandidatesPending, allRealFilesUnchanged: report.allRealFilesUnchanged }));
}

await main();
