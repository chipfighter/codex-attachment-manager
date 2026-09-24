// Purpose: P2-5 — end-to-end check of rewriting in one thread with our own app-server in the desktop's environment
// (NO_PROXY removed, respect_system_proxy on, localhost base URL; config.toml untouched):
// upload four synthetic images (one a renamed byte copy, one ~3 MB of noise) → uncheck the original, the copy and the
// large one → ask about the first two → re-check the original → ask again → check everything → one more turn.
// The proxy must already run (no flags).
// Input: [--port 17891] [--label name]. Output: local/p2/selftest-<label>.json (synthetic test thread only).

import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { AppServer, findBundledCodex } from "./appserver.ts";
import { codexHome } from "./codexconfig.ts";
import { readSelection, writeSelection } from "./selection.ts";
import { runTurn, testImages, text } from "./testkit.ts";
import { loadThreadIndex } from "./thread-index.ts";

type Json = Record<string, any>;
const localRoot = join(resolve(dirname(fileURLToPath(import.meta.url)), "../.."), "local");

function setChecked(threadId: string, keys: Record<string, string>, uncheck: string[]): void {
  writeSelection({ threadId, unchecked: Object.fromEntries(uncheck.map((id) => [keys[id], { id, at: new Date().toISOString() }])) });
}

async function main(): Promise<void> {
  const option = (name: string, fallback: string) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : fallback);
  const port = Number(option("--port", "17891"));
  const label = option("--label", "default");
  const workDir = join(localRoot, "p2", "work");
  mkdirSync(workDir, { recursive: true });
  const file = (name: string) => join(workDir, name);
  writeFileSync(file("a.png"), testImages.redSquare());
  writeFileSync(file("b.png"), testImages.blueCircle());
  copyFileSync(file("b.png"), file("b-copy.png"));
  writeFileSync(file("noise.png"), testImages.noise());

  const startedAt = new Date().toISOString();
  const server = new AppServer(findBundledCodex(), ["-c", `openai_base_url="http://localhost:${port}/backend-api/codex"`, "-c", "features.respect_system_proxy=true"], { NO_PROXY: undefined, no_proxy: undefined }, join(localRoot, "logs", `p2-selftest-${label}-${startedAt.replaceAll(":", "-")}.log`));
  const result: Json = { createdAt: startedAt, label, turns: {} };
  let threadId = "";
  try {
    await server.initialize();
    const { thread } = await server.request<{ thread: Json }>("thread/start", { cwd: workDir, approvalPolicy: "never", sandbox: "read-only", ephemeral: false });
    threadId = thread.id;
    result.threadId = threadId;
    await server.request("thread/name/set", { threadId, name: `[CAM测试] P2 改写自测 ${label}` });

    result.turns.upload = await runTurn(server, threadId, [text("这是四张测试图，先不用描述，只回复“收到”。"), ...["a.png", "b.png", "b-copy.png", "noise.png"].map((name) => ({ type: "localImage", path: file(name) }))]);
    const index = loadThreadIndex(join(codexHome(), "sessions"), threadId);
    result.index = index.images.map((image) => ({ id: image.id, name: image.name, kind: image.kind, turn: image.turn, contentHash: image.contentId.slice(0, 16) }));
    const keys = Object.fromEntries(index.images.map((image) => [image.id, image.key]));

    setChecked(threadId, keys, ["IMG-001", "IMG-003", "IMG-004"]);
    result.selectionAfterUncheck = Object.values(readSelection(threadId).unchecked).map((entry) => entry.id);
    await sleep(3000);
    const question = "请分别回答：1）第一张图 a.png 是什么背景色、什么主要形状，角落里有什么小标记，在哪个角？2）第三张图 b-copy.png 呢？不要调用任何工具。";
    result.turns.unchecked = await runTurn(server, threadId, [text(question)]);

    setChecked(threadId, keys, ["IMG-003", "IMG-004"]);
    result.turns.rechecked = await runTurn(server, threadId, [text("我重新提供了 a.png。请再回答一次第 1 个问题：它是什么背景色、什么主要形状，角落里有什么小标记，在哪个角？不要调用任何工具。")]);

    setChecked(threadId, keys, []);
    result.turns.allChecked = await runTurn(server, threadId, [text("请只回复“好的”。")]);

    const read = await server.request<{ thread: Json }>("thread/read", { threadId, includeTurns: true });
    result.threadTurns = read.thread.turns?.length ?? null;
  } finally {
    await server.stop();
  }

  const entries: Json[] = readFileSync(join(localRoot, "proxy", `${new Date().toISOString().slice(0, 10)}.jsonl`), "utf8")
    .trim().split("\n").map((line) => JSON.parse(line)).filter((entry) => entry.at >= startedAt && entry.threadId === threadId);
  const turnIds = Object.fromEntries(Object.entries(result.turns as Record<string, Json>).map(([name, turn]) => [turn.turnId, name]));
  result.proxy = entries.map((entry) => ({
    turn: turnIds[entry.turnId] ?? entry.turnId,
    transport: entry.transport,
    what: entry.declined ? `declined ${entry.declined}` : entry.transport === "websocket" ? `${entry.upstreamStatus} closedForSelection=${entry.closedForSelection}` : `${entry.method} ${entry.path.split("/").pop()} ${entry.status}`,
    rewrite: entry.rewrite ? { replaced: entry.rewrite.replaced?.map((r: Json) => `${r.id}:${r.mode}${r.sameAs ? `->${r.sameAs}` : ""}`), sent: entry.rewrite.sentImageHashes, skipped: entry.rewrite.skipped, roundTripExact: entry.rewrite.roundTripExact, decoded: [entry.rewrite.decodedBefore, entry.rewrite.decodedAfter], encoded: [entry.rewrite.encodedBefore, entry.rewrite.encodedAfter] } : null,
    requestBytes: entry.requestBytes ?? entry.upBytes,
  }));

  const hash = (id: string) => (result.index as Json[]).find((image) => image.id === id)?.contentHash;
  const posts = (turn: string) => (result.proxy as Json[]).filter((entry) => entry.turn === turn && entry.transport === "http" && /responses/.test(entry.what));
  const turn2 = posts("unchecked");
  const turn3 = posts("rechecked");
  const turn4 = posts("allChecked");
  result.checks = {
    indexFoundCopy: JSON.stringify((result.index as Json[]).map((image) => image.name)) === JSON.stringify(["a.png", "b.png", "b-copy.png", "noise.png"]) && hash("IMG-002") === hash("IMG-003"),
    websocketClosedAfterUncheck: (result.proxy as Json[]).some((entry) => /closedForSelection=true/.test(entry.what)) || !(result.proxy as Json[]).some((entry) => entry.transport === "websocket" && entry.turn === "upload"),
    turn2Rewritten: turn2.length > 0 && turn2.every((entry) => JSON.stringify(entry.rewrite?.replaced) === JSON.stringify(["IMG-001:plain", "IMG-003:duplicate->IMG-002", "IMG-004:plain"]) && !entry.rewrite.sent.includes(hash("IMG-001")) && !entry.rewrite.sent.includes(hash("IMG-004"))),
    turn2Smaller: turn2.length > 0 && turn2.every((entry) => entry.rewrite.encoded[1] < entry.rewrite.encoded[0] - 1_000_000),
    turn2AsksForImage: /IMG-001/.test(result.turns.unchecked.reply),
    turn3SendsImageAgain: turn3.length > 0 && turn3.every((entry) => JSON.stringify(entry.rewrite?.replaced) === JSON.stringify(["IMG-003:duplicate->IMG-002", "IMG-004:plain"]) && entry.rewrite.sent.includes(hash("IMG-001"))),
    turn3SeesImage: /红/.test(result.turns.rechecked.reply) && /黑/.test(result.turns.rechecked.reply),
    turn4PassThrough: turn4.length > 0 && turn4.every((entry) => entry.rewrite === null),
    noErrors: Object.values(result.turns as Record<string, Json>).every((turn) => turn.status === "completed" && !turn.errors.length),
    sameThreadAllTurns: result.threadTurns === 4,
  };
  writeFileSync(join(localRoot, "p2", `selftest-${label}.json`), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ threadId, checks: result.checks, replies: Object.fromEntries(Object.entries(result.turns as Record<string, Json>).map(([name, turn]) => [name, turn.reply])), proxy: result.proxy }, null, 2));
}

await main();
