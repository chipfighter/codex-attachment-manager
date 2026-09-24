// Purpose: T4–T8 — rebuild a thread through app-server: inject migrated history, then run turns with chosen attachments.
// Input: subcommands
//   preview --source <threadId> --select IMG-a,IMG-b
//   create  --source <threadId> --select IMG-a,IMG-b --prompt <text> [--effort medium]
//   turn    --thread <threadId> [--attach IMG-c] --prompt <text> --label <name> [--disable <feature>] [--effort medium]
//   probe   --source <threadId> --prompt <text> --label <name> [--disable <feature>] [--config key=value]… (ephemeral thread)
// Output: local/rebuild-preview.{json,md}, local/t4-rebuild.json, local/turn-<label>.json, local/probe-<label>.json
// (local only, never committed).

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AppServer, findBundledCodex, type Notification } from "./appserver.ts";
import { baseName, buildMigration, type AssetInfo } from "./migrate.ts";
import { decodePng } from "./png.ts";

type Json = Record<string, any>;
const localRoot = join(resolve(dirname(fileURLToPath(import.meta.url)), "../.."), "local");

function option(name: string, fallback?: string): string {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (value !== undefined) return value;
  if (fallback !== undefined) return fallback;
  throw new Error(`missing ${name}`);
}

// Resolves an image path to an indexed asset by content (bytes first, then pixels). When Codex resized an upload,
// content no longer matches, so user uploads fall back to the path recorded next to the image in the same message.
function loadAssets(): { resolveImage: (path: string) => AssetInfo | null; attachmentPath: (assetId: string) => string } {
  const inventory: Json = JSON.parse(readFileSync(join(localRoot, "assets.json"), "utf8"));
  const matches: Json = JSON.parse(readFileSync(join(localRoot, "matches.json"), "utf8"));
  const byByte = new Map<string, string>();
  const byPixel = new Map<string, string>();
  const info = new Map<string, AssetInfo>();
  for (const asset of inventory.assets) {
    for (const hash of asset.byteHashes) byByte.set(hash, asset.assetId);
    if (asset.pixelSha256) byPixel.set(asset.pixelSha256, asset.assetId);
    const occurrences = inventory.occurrences.filter((o: Json) => o.assetId === asset.assetId);
    const named = occurrences.map((o: Json) => o.knownLocalPath).find((path: string | null) => path && !/codex-clipboard-/.test(path));
    info.set(asset.assetId, { assetId: asset.assetId, name: named ? baseName(named) : "剪贴板图片", width: asset.width, height: asset.height, bytes: occurrences[0].byteLength });
  }
  const byUploadPath = new Map<string, string>();
  for (const occurrence of inventory.occurrences) {
    if (occurrence.source === "user_upload" && occurrence.knownLocalPath) byUploadPath.set(occurrence.knownLocalPath.toLowerCase(), occurrence.assetId);
  }
  const cache = new Map<string, AssetInfo | null>();
  const resolveImage = (path: string): AssetInfo | null => {
    if (cache.has(path)) return cache.get(path)!;
    let found: string | undefined;
    if (path && existsSync(path)) {
      const bytes = readFileSync(path);
      found = byByte.get(createHash("sha256").update(bytes).digest("hex"));
      if (!found) { try { found = byPixel.get(decodePng(bytes).pixelSha256); } catch { /* not a decodable PNG */ } }
    }
    found ??= path ? byUploadPath.get(path.toLowerCase()) : undefined;
    const result = found ? info.get(found)! : null;
    cache.set(path, result);
    return result;
  };
  const attachmentPath = (assetId: string): string => {
    const match = matches.matches.find((m: Json) => m.assetId === assetId);
    if (!match?.attachmentPath) throw new Error(`no attachment file for ${assetId}`);
    return match.attachmentPath;
  };
  return { resolveImage, attachmentPath };
}

function options(name: string): string[] {
  return process.argv.flatMap((arg, i) => (arg === name && process.argv[i + 1] !== undefined ? [process.argv[i + 1]] : []));
}

function startServer(label: string, extraArgs: string[] = [], serverRequests: Json[] = []): AppServer {
  mkdirSync(join(localRoot, "logs"), { recursive: true });
  const stamp = new Date().toISOString().replaceAll(":", "-");
  // Server requests are recorded so experiments can show what the app-server asked for; the default decline still applies.
  return new AppServer(findBundledCodex(), extraArgs, {}, join(localRoot, "logs", `${label}-appserver-${stamp}.log`), (method, params) => {
    serverRequests.push({ method, params });
    return undefined;
  });
}

async function sourceTurns(server: AppServer, threadId: string): Promise<{ thread: Json; turns: Json[] }> {
  const { thread } = await server.request<{ thread: Json }>("thread/read", { threadId, includeTurns: false });
  const turns: Json[] = [];
  let cursor: string | null = null;
  do {
    const page: Json = await server.request("thread/turns/list", { threadId, cursor, limit: 50, sortDirection: "asc", itemsView: "full" }, 300_000);
    turns.push(...page.data);
    cursor = page.nextCursor;
  } while (cursor);
  return { thread, turns };
}

function attachmentInput(assetIds: string[], attachmentPath: (id: string) => string, prompt: string): Json[] {
  const legend = assetIds.length ? `【附件管理器】本轮附件：${assetIds.map((id, i) => `附件 ${i + 1} = ${id}`).join("，")}。\n` : "";
  return [
    { type: "text", text: `${legend}${prompt}`, text_elements: [] },
    ...assetIds.map((id) => ({ type: "localImage", path: attachmentPath(id) })),
  ];
}

// Runs one turn and waits for its completion notification; returns what the turn produced.
async function runTurn(server: AppServer, threadId: string, input: Json[], effort: string): Promise<Json> {
  const startedAt = Date.now();
  const before = server.notifications.length;
  const { turn } = await server.request<{ turn: Json }>("turn/start", { threadId, input, effort }, 120_000);
  const done: Notification = await server.waitFor((n) => n.method === "turn/completed" && n.params.turn?.id === turn.id, 20 * 60_000);
  const mine = server.notifications.slice(before).filter((n) => n.params?.turnId === turn.id || n.params?.turn?.id === turn.id);
  const items = mine.filter((n) => n.method === "item/completed").map((n) => n.params.item);
  return {
    turnId: turn.id,
    status: done.params.turn.status,
    error: done.params.turn.error ?? null,
    wallMs: Date.now() - startedAt,
    itemTypes: items.map((item) => item.type),
    agentText: items.filter((item) => item.type === "agentMessage").map((item) => item.text).join("\n\n"),
    toolItems: items.filter((item) => !["agentMessage", "reasoning", "userMessage"].includes(item.type)).map((item) => ({
      type: item.type, status: item.status, path: item.path, server: item.server, tool: item.tool, command: item.command,
      // Content types only (never data), to see whether a tool returned an image into history.
      resultContentTypes: Array.isArray(item.result?.content) ? item.result.content.map((part: Json) => part.type) : undefined,
    })),
    errors: mine.filter((n) => n.method === "error").map((n) => n.params),
    tokenUsage: mine.filter((n) => n.method === "thread/tokenUsage/updated").map((n) => n.params.tokenUsage).at(-1) ?? null,
  };
}

async function preview(server: AppServer, sourceId: string, selected: string[]) {
  const { resolveImage, attachmentPath } = loadAssets();
  const { thread, turns } = await sourceTurns(server, sourceId);
  const attachments = new Map(selected.map((id, i) => [id, i + 1]));
  const migration = buildMigration(turns, resolveImage, { sourceName: thread.name ?? thread.preview, attachments });
  const injectedBytes = Buffer.byteLength(JSON.stringify(migration.items), "utf8");
  const summary = {
    sourceThreadId: sourceId,
    sourceName: thread.name,
    sourceTurns: turns.length,
    injectedItems: migration.items.length,
    injectedBytes,
    imageOccurrences: migration.imageOccurrences,
    unresolvedImages: migration.unresolvedImages,
    assetsInHistory: migration.firstSeen.map(({ asset, turn, source }) => ({ assetId: asset.assetId, name: asset.name, turn, source, selected: attachments.has(asset.assetId) })),
    selected: selected.map((id) => ({ assetId: id, attachmentPath: attachmentPath(id) })),
  };
  writeFileSync(join(localRoot, "rebuild-preview.json"), JSON.stringify({ ...summary, items: migration.items }, null, 2));
  writeFileSync(join(localRoot, "rebuild-preview.md"), [
    "# 重建预览（仅本机）", "",
    "```json", JSON.stringify(summary, null, 2), "```", "",
    ...migration.items.map((item, i) => `## ${i + 1}. ${item.role}\n\n${item.content[0].text}\n`),
  ].join("\n"));
  return { thread, migration, summary, attachmentPath };
}

async function main(): Promise<void> {
  const command = process.argv[2];
  const effort = option("--effort", "medium");
  if (command === "preview" || command === "create") {
    const sourceId = option("--source");
    const selected = option("--select", "").split(",").filter(Boolean);
    const server = startServer(command === "preview" ? "preview" : "t4");
    try {
      await server.initialize();
      const { thread, migration, summary, attachmentPath } = await preview(server, sourceId, selected);
      console.log(JSON.stringify({ ...summary, selected: summary.selected.map((s) => s.assetId) }, null, 2));
      if (command === "preview") return;
      const started = await server.request<{ thread: Json }>("thread/start", {
        model: thread.model, cwd: thread.cwd, approvalPolicy: "never", sandbox: "read-only", ephemeral: false,
      });
      const threadId = started.thread.id;
      await server.request("thread/inject_items", { threadId, items: migration.items }, 120_000);
      const name = `[CAM测试] ${thread.name ?? "重建任务"}`;
      await server.request("thread/name/set", { threadId, name });
      const turn = await runTurn(server, threadId, attachmentInput(selected, attachmentPath, option("--prompt")), effort);
      const result = { createdAt: new Date().toISOString(), threadId, name, model: thread.model, effort, selected, preview: summary, turn };
      writeFileSync(join(localRoot, "t4-rebuild.json"), JSON.stringify(result, null, 2));
      console.log(JSON.stringify({ threadId, name, turn: { ...turn, agentText: turn.agentText.slice(0, 600) } }, null, 2));
    } finally {
      console.log(`app-server exit code: ${await server.stop()}`);
    }
    return;
  }
  if (command === "turn") {
    const threadId = option("--thread");
    const label = option("--label");
    const attach = option("--attach", "").split(",").filter(Boolean);
    const disabled = option("--disable", "").split(",").filter(Boolean);
    const { attachmentPath } = loadAssets();
    const server = startServer(`turn-${label}`, disabled.flatMap((feature) => ["--disable", feature]));
    try {
      await server.initialize();
      await server.request("thread/resume", { threadId, approvalPolicy: "never", sandbox: "read-only" }, 300_000);
      const turn = await runTurn(server, threadId, attachmentInput(attach, attachmentPath, option("--prompt")), effort);
      const result = { createdAt: new Date().toISOString(), threadId, label, attach, disabled, effort, turn };
      writeFileSync(join(localRoot, `turn-${label}.json`), JSON.stringify(result, null, 2));
      console.log(JSON.stringify({ label, turn: { ...turn, agentText: turn.agentText.slice(0, 800) } }, null, 2));
    } finally {
      console.log(`app-server exit code: ${await server.stop()}`);
    }
    return;
  }
  if (command === "probe") {
    const label = option("--label");
    const disabled = option("--disable", "").split(",").filter(Boolean);
    const configs = options("--config");
    const serverRequests: Json[] = [];
    const server = startServer(`probe-${label}`, [...disabled.flatMap((f) => ["--disable", f]), ...configs.flatMap((c) => ["-c", c])], serverRequests);
    try {
      await server.initialize();
      const { thread } = await server.request<{ thread: Json }>("thread/read", { threadId: option("--source"), includeTurns: false });
      const started = await server.request<{ thread: Json }>("thread/start", { model: thread.model, cwd: thread.cwd, approvalPolicy: "never", sandbox: "read-only", ephemeral: true });
      const turn = await runTurn(server, started.thread.id, [{ type: "text", text: option("--prompt"), text_elements: [] }], effort);
      const result = { createdAt: new Date().toISOString(), label, disabled, configs, ephemeralThreadId: started.thread.id, turn, serverRequests };
      writeFileSync(join(localRoot, `probe-${label}.json`), JSON.stringify(result, null, 2));
      console.log(JSON.stringify({ label, serverRequests: serverRequests.map((r) => r.method), turn: { ...turn, agentText: turn.agentText.slice(0, 800) } }, null, 2));
    } finally {
      console.log(`app-server exit code: ${await server.stop()}`);
    }
    return;
  }
  throw new Error("usage: rebuild.ts preview|create|turn|probe …");
}

await main();
