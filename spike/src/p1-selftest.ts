// Purpose: P1-3 — run text, attached image, image generation and image edit through our own app-server pointed at
// the local proxy (`-c openai_base_url`, the user's config.toml is not touched), then match the proxy log.
// Input: [--port 17891] [--host localhost] [--desktop-env] [--only-text] [--label name]; the proxy must already be running.
// --desktop-env drops NO_PROXY so the app-server sees the same proxy environment as the desktop app;
// --respect-system-proxy turns on features.respect_system_proxy, as the managed config.toml does.
// Output: local/p1-selftest-<label>.json and a console summary.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";
import { AppServer, findBundledCodex } from "./appserver.ts";
import { TEST_MODEL } from "./testkit.ts";

type Json = Record<string, any>;
const localRoot = join(resolve(dirname(fileURLToPath(import.meta.url)), "../.."), "local");

// A synthetic 256×256 RGB gradient, so no user material is sent for the attachment test.
function testPattern(): Buffer {
  const width = 256;
  const height = 256;
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (width * 3 + 1);
    for (let x = 0; x < width; x++) {
      raw[row + 1 + x * 3] = x;
      raw[row + 2 + x * 3] = y;
      raw[row + 3 + x * 3] = 160;
    }
  }
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(Buffer.concat([Buffer.from(type, "ascii"), data])));
    return Buffer.concat([length, Buffer.from(type, "ascii"), data, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), chunk("IHDR", header), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

async function turn(server: AppServer, threadId: string, input: Json[]): Promise<Json> {
  const started = Date.now();
  const before = server.notifications.length;
  const { turn } = await server.request<{ turn: Json }>("turn/start", { threadId, input, effort: "low" }, 120_000);
  const done = await server.waitFor((n) => n.method === "turn/completed" && n.params.turn?.id === turn.id, 20 * 60_000);
  const mine = server.notifications.slice(before).filter((n) => n.params?.turnId === turn.id || n.params?.turn?.id === turn.id);
  const items = mine.filter((n) => n.method === "item/completed").map((n) => n.params.item);
  return {
    turnId: turn.id,
    status: done.params.turn.status,
    error: done.params.turn.error ?? null,
    ms: Date.now() - started,
    tools: items.filter((item) => !["agentMessage", "reasoning", "userMessage"].includes(item.type)).map((item) => `${item.type}:${item.status ?? ""}`),
    reply: items.filter((item) => item.type === "agentMessage").map((item) => item.text).join(" ").slice(0, 200),
    errors: mine.filter((n) => n.method === "error").map((n) => n.params.error?.message ?? "error"),
  };
}

async function main(): Promise<void> {
  const option = (name: string, fallback: string) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : fallback);
  const port = Number(option("--port", "17891"));
  const host = option("--host", "localhost");
  const label = option("--label", "default");
  const desktopEnv = process.argv.includes("--desktop-env");
  const onlyText = process.argv.includes("--only-text");
  const workDir = join(localRoot, "p1");
  mkdirSync(join(localRoot, "logs"), { recursive: true });
  mkdirSync(workDir, { recursive: true });
  const pattern = join(workDir, "test-pattern.png");
  writeFileSync(pattern, testPattern());

  const startedAt = new Date().toISOString();
  const env = desktopEnv ? { NO_PROXY: undefined, no_proxy: undefined } : {};
  const extra = process.argv.includes("--respect-system-proxy") ? ["-c", "features.respect_system_proxy=true"] : [];
  const server = new AppServer(findBundledCodex(), ["-c", `openai_base_url="http://${host}:${port}/backend-api/codex"`, ...extra], env, join(localRoot, "logs", `p1-selftest-${label}-appserver-${startedAt.replaceAll(":", "-")}.log`));
  const results: Json = {};
  let threadId = "";
  try {
    await server.initialize();
    const started = await server.request<{ thread: Json }>("thread/start", { model: TEST_MODEL, cwd: workDir, approvalPolicy: "never", sandbox: "read-only", ephemeral: true });
    threadId = started.thread.id;
    const text = (value: string) => ({ type: "text", text: value, text_elements: [] });
    results.text = await turn(server, threadId, [text("请只回复“收到”两个字。")]);
    if (onlyText) return;
    results.attachment = await turn(server, threadId, [text("附件里是什么图案？用一句话回答，不需要调用任何工具。"), { type: "localImage", path: pattern }]);
    results.imageGeneration = await turn(server, threadId, [text("请用内置的生图工具生成一张简单的图片：浅蓝色背景，正中间一个黄色圆形。生成 1 张即可。")]);
    results.imageEdit = await turn(server, threadId, [text("请用内置的生图工具修改刚才那张图：把黄色圆形改成红色，其余保持不变。生成 1 张即可。")]);
  } finally {
    await server.stop();
    await summarize(threadId, startedAt, { host, port, desktopEnv, respectSystemProxy: extra.length > 0, onlyText, label }, results);
  }
}

async function summarize(threadId: string, startedAt: string, options: Json, results: Json): Promise<void> {
  const logFile = join(localRoot, "proxy", `${new Date().toISOString().slice(0, 10)}.jsonl`);
  const entries = readFileSync(logFile, "utf8").trim().split("\n").map((line) => JSON.parse(line)).filter((entry: Json) => entry.at >= startedAt);
  const forThread = entries.filter((entry: Json) => entry.threadId === threadId);
  const summary = Object.values(forThread.reduce((groups: Record<string, Json>, entry: Json) => {
    const key = `${entry.transport} ${entry.method ?? "GET"} ${entry.path} ${entry.status ?? entry.upstreamStatus ?? ""}`;
    groups[key] ??= { request: key, count: 0 };
    groups[key].count++;
    return groups;
  }, {}));
  const report = { createdAt: new Date().toISOString(), options, threadId, results, proxyEntriesInWindow: entries.length, proxyEntriesForThread: forThread.length, summary, otherThreadIds: [...new Set(entries.map((e: Json) => e.threadId).filter((id: string | null) => id && id !== threadId))] };
  writeFileSync(join(localRoot, `p1-selftest-${options.label}.json`), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ options, results, summary, proxyEntriesInWindow: entries.length, proxyEntriesForThread: forThread.length }, null, 2));
}

await main();
