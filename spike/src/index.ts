// Purpose: read sample Codex rollout JSONL files and build a local-only image timeline.
// Input: --sessions <directory> --threads <id,id>; output: local/assets.json and local/assets.md.

import { createHash } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { decodePng } from "../../plugin/src/png.ts";
import { fileSha256, pathForViewedImage } from "./viewpaths.ts";

type Json = Record<string, any>;
type Occurrence = {
  threadId: string;
  turnId: string | null;
  turnNumber: number | null;
  timestamp: string;
  source: "user_upload" | "view_image" | "tool_output";
  byteLength: number;
  byteSha256: string;
  pixelSha256: string | null;
  width: number | null;
  height: number | null;
  mime: string;
  knownLocalPath: string | null;
  rolloutFile: string;
  line: number;
  contentIndex: number;
  assetId: string;
};

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const localRoot = join(repoRoot, "local");

function argument(name: string): string {
  const index = process.argv.indexOf(name);
  const value = process.argv[index + 1];
  if (index < 0 || !value || value.startsWith("--")) throw new Error(`missing ${name}`);
  return value;
}

function walk(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = join(directory, entry.name);
    return entry.isDirectory() ? walk(full) : entry.isFile() ? [full] : [];
  });
}

function localPathFromText(text: unknown): string | null {
  if (typeof text !== "string") return null;
  const found = text.match(/\bpath\s*=\s*["']([^"']+)["']/i)?.[1];
  if (!found) return null;
  if (found.startsWith("file://")) {
    try { return fileURLToPath(found); } catch { return null; }
  }
  return isAbsolute(found) ? found : null;
}

function pathBefore(content: Json[], index: number): string | null {
  for (let i = index - 1; i >= 0; i--) {
    const found = localPathFromText(content[i]?.text);
    if (found) return found;
  }
  return null;
}

function imageParts(item: Json): Array<{ image: Json; index: number; path: string | null }> {
  const content: Json[] = Array.isArray(item.content) ? item.content : Array.isArray(item.output) ? item.output : [];
  return content.flatMap((part, index) =>
    part?.type === "input_image" || part?.type === "output_image"
      ? [{ image: part, index, path: pathBefore(content, index) }]
      : [],
  );
}

function pathFromImageView(uri: unknown): string | null {
  if (typeof uri !== "string") return null;
  if (uri.startsWith("file://")) {
    try { return fileURLToPath(uri); } catch { return null; }
  }
  return isAbsolute(uri) ? uri : null;
}

function markdownCell(value: unknown): string {
  return String(value ?? "—").replaceAll("|", "\\|").replaceAll("\n", " ");
}

async function main(): Promise<void> {
  const sessions = resolve(argument("--sessions"));
  const threadIds = argument("--threads").split(",").filter(Boolean);
  if (!threadIds.length || !existsSync(sessions)) throw new Error("sessions directory or thread ids unavailable");
  mkdirSync(localRoot, { recursive: true });
  const actualLocal = realpathSync(localRoot);
  if (relative(repoRoot, actualLocal).startsWith("..")) throw new Error("local output points outside the repository");

  const files = walk(sessions)
    .filter((file) => file.endsWith(".jsonl") && threadIds.some((id) => basename(file).includes(id)))
    .sort();
  if (!files.length) throw new Error("no sample rollout files found");
  const before = new Map<string, string>();
  for (const file of files) before.set(file, await fileSha256(file));

  const occurrences: Occurrence[] = [];
  const unrecognized: Json[] = [];
  const turns: Array<{ threadId: string; turnId: string; timestamp: string }> = [];
  const decoded = new Map<string, { pixelSha256: string; width: number; height: number }>();
  const viewedFileHashes = new Map<string, string | null>();
  for (const file of files) {
    let lineNumber = 0;
    let threadId: string | null = null;
    let activeTurn: string | null = null;
    const calls = new Map<string, Json>();
    let pendingViews: string[] = [];
    const input = createInterface({ input: createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
    for await (const line of input) {
      lineNumber++;
      let record: Json;
      try { record = JSON.parse(line); }
      catch {
        unrecognized.push({ rolloutFile: basename(file), line: lineNumber, reason: "invalid_json" });
        continue;
      }
      const payload: Json = record.payload ?? {};
      if (record.type === "session_meta") {
        threadId = payload.id ?? null;
        continue;
      }
      if (!threadId || !threadIds.includes(threadId)) continue;
      if (record.type === "event_msg" && payload.type === "task_started") {
        activeTurn = payload.turn_id ?? null;
        if (activeTurn) turns.push({ threadId, turnId: activeTurn, timestamp: record.timestamp });
      }
      if (record.type === "event_msg" && payload.type === "item_completed" && payload.item?.type === "ImageView") {
        const viewedPath = pathFromImageView(payload.item.path);
        if (viewedPath) pendingViews.push(viewedPath);
        else unrecognized.push({ rolloutFile: basename(file), line: lineNumber, reason: "image_view_path_unreadable" });
      }
      if (record.type !== "response_item") continue;
      if (payload.type === "custom_tool_call") {
        calls.set(payload.call_id, { name: payload.name, input: payload.input });
        continue;
      }
      const parts = imageParts(payload);
      if (!parts.length) continue;
      const call = calls.get(payload.call_id);
      const source: Occurrence["source"] = payload.type === "message" && payload.role === "user"
        ? "user_upload"
        : String(call?.input ?? "").includes("view_image") ? "view_image" : "tool_output";
      const viewCandidates = source === "view_image" ? pendingViews.splice(0, parts.length) : [];
      for (const { image, index, path } of parts) {
        const url = image.image_url ?? image.url;
        const match = typeof url === "string" ? /^data:([^;,]+);base64,(.+)$/s.exec(url) : null;
        if (!match) {
          unrecognized.push({ rolloutFile: basename(file), line: lineNumber, contentIndex: index, reason: "image_without_inline_data" });
          continue;
        }
        const bytes = Buffer.from(match[2], "base64");
        const byteSha256 = createHash("sha256").update(bytes).digest("hex");
        let info = decoded.get(byteSha256);
        if (!info && match[1] === "image/png") {
          try {
            const png = decodePng(bytes);
            info = { pixelSha256: png.pixelSha256, width: png.width, height: png.height };
            decoded.set(byteSha256, info);
          } catch (error) {
            unrecognized.push({ rolloutFile: basename(file), line: lineNumber, contentIndex: index, reason: "pixel_decode_failed", detail: String(error) });
          }
        }
        if (match[1] !== "image/png") {
          unrecognized.push({ rolloutFile: basename(file), line: lineNumber, contentIndex: index, reason: "unsupported_image_mime", mime: match[1] });
        }
        occurrences.push({
          threadId,
          turnId: payload.internal_chat_message_metadata_passthrough?.turn_id ?? activeTurn,
          turnNumber: null,
          timestamp: record.timestamp,
          source,
          byteLength: bytes.length,
          byteSha256,
          pixelSha256: info?.pixelSha256 ?? null,
          width: info?.width ?? null,
          height: info?.height ?? null,
          mime: match[1],
          knownLocalPath: source === "view_image" ? await pathForViewedImage(viewCandidates, byteSha256, viewedFileHashes) : path,
          rolloutFile: basename(file),
          line: lineNumber,
          contentIndex: index,
          assetId: "",
        });
      }
    }
    for (const viewedPath of pendingViews) {
      unrecognized.push({ rolloutFile: basename(file), reason: "image_view_without_inline_result", knownLocalPath: viewedPath });
    }
  }

  const turnNumbers = new Map<string, number>();
  for (const id of threadIds) {
    const sorted = turns.filter((turn) => turn.threadId === id).sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    for (const turn of sorted) {
      const key = `${id}:${turn.turnId}`;
      if (!turnNumbers.has(key)) turnNumbers.set(key, [...turnNumbers.keys()].filter((value) => value.startsWith(`${id}:`)).length + 1);
    }
  }
  occurrences.sort((a, b) => a.timestamp.localeCompare(b.timestamp) || a.rolloutFile.localeCompare(b.rolloutFile) || a.line - b.line || a.contentIndex - b.contentIndex);
  const assets: Array<Json> = [];
  const groups = new Map<string, Json>();
  for (const occurrence of occurrences) {
    occurrence.turnNumber = occurrence.turnId ? turnNumbers.get(`${occurrence.threadId}:${occurrence.turnId}`) ?? null : null;
    const groupKey = occurrence.pixelSha256 ? `pixel:${occurrence.pixelSha256}` : `byte:${occurrence.byteSha256}`;
    let asset = groups.get(groupKey);
    if (!asset) {
      asset = { assetId: `IMG-${String(assets.length + 1).padStart(3, "0")}`, pixelSha256: occurrence.pixelSha256, width: occurrence.width, height: occurrence.height, byteHashes: [], occurrenceCount: 0, threadIds: [] };
      groups.set(groupKey, asset);
      assets.push(asset);
    }
    occurrence.assetId = asset.assetId;
    asset.occurrenceCount++;
    if (!asset.byteHashes.includes(occurrence.byteSha256)) asset.byteHashes.push(occurrence.byteSha256);
    if (!asset.threadIds.includes(occurrence.threadId)) asset.threadIds.push(occurrence.threadId);
  }

  const sourceFiles = [];
  for (const file of files) {
    const afterSha256 = await fileSha256(file);
    sourceFiles.push({ path: file, bytes: statSync(file).size, beforeSha256: before.get(file), afterSha256, unchanged: before.get(file) === afterSha256 });
  }
  const manifest = { createdAt: new Date().toISOString(), threadIds, sourceFiles, originalFilesUnchanged: sourceFiles.every((source) => source.unchanged), assets, occurrences, unrecognized };
  writeFileSync(join(localRoot, "assets.json"), JSON.stringify(manifest, null, 2));

  const rows = occurrences.map((o) => `| ${markdownCell(o.threadId.slice(0, 8))} | ${markdownCell(o.turnNumber)} | ${markdownCell(o.timestamp)} | ${markdownCell(o.source)} | ${o.assetId} | ${o.byteLength} | ${o.byteSha256.slice(0, 12)} | ${markdownCell(o.pixelSha256?.slice(0, 12))} | ${markdownCell(o.width && o.height ? `${o.width}×${o.height}` : null)} | ${markdownCell(o.knownLocalPath)} | ${markdownCell(`${o.rolloutFile}:${o.line}:${o.contentIndex}`)} |`);
  const report = [
    "# 阶段 0 素材清单（仅本机）", "",
    `记录文件：${files.length}；图片出现记录：${occurrences.length}；素材：${assets.length}；无法识别：${unrecognized.length}；原文件哈希不变：${manifest.originalFilesUnchanged}`, "",
    "| 任务 | 轮次 | 时间 UTC | 来源 | 素材 | 图片字节 | 字节 SHA 前缀 | 像素 SHA 前缀 | 尺寸 | 已知本地路径 | 记录位置 |",
    "| --- | ---: | --- | --- | --- | ---: | --- | --- | --- | --- | --- |",
    ...rows, "", "## 无法识别的项目", "", "```json", JSON.stringify(unrecognized, null, 2), "```", "",
  ].join("\n");
  writeFileSync(join(localRoot, "assets.md"), report);
  console.log(JSON.stringify({ files: files.length, occurrences: occurrences.length, assets: assets.length, unrecognized: unrecognized.length, originalFilesUnchanged: manifest.originalFilesUnchanged, byThread: Object.fromEntries(threadIds.map((id) => [id, { occurrences: occurrences.filter((o) => o.threadId === id).length, assets: new Set(occurrences.filter((o) => o.threadId === id).map((o) => o.assetId)).size }])) }));
}

await main();
