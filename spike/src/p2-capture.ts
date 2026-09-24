// Purpose: P2-1 — produce Responses requests that contain every kind of image (uploads incl. a renamed byte copy,
// a view_image result, a generated image) in a synthetic test thread, so the proxy's --dump-requests output shows
// where images sit in the request. The proxy must already run with --force-http --dump-requests.
// Input: [--port 17891] [--label name]. Output: local/p2/capture-<label>.json; request dumps come from the proxy.

import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AppServer, findBundledCodex } from "./appserver.ts";
import { runTurn, TEST_MODEL, testImages, text } from "./testkit.ts";

type Json = Record<string, any>;
const localRoot = join(resolve(dirname(fileURLToPath(import.meta.url)), "../.."), "local");

async function main(): Promise<void> {
  const option = (name: string, fallback: string) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : fallback);
  const port = Number(option("--port", "17891"));
  const label = option("--label", "default");
  const workDir = join(localRoot, "p2", "work");
  mkdirSync(workDir, { recursive: true });
  mkdirSync(join(localRoot, "logs"), { recursive: true });
  const file = (name: string) => join(workDir, name);
  writeFileSync(file("a.png"), testImages.redSquare());
  writeFileSync(file("b.png"), testImages.blueCircle());
  copyFileSync(file("b.png"), file("b-copy.png"));
  writeFileSync(file("c.png"), testImages.whiteTriangle());

  const startedAt = new Date().toISOString();
  const server = new AppServer(findBundledCodex(), ["-c", `openai_base_url="http://localhost:${port}/backend-api/codex"`, "-c", "features.respect_system_proxy=true"], {}, join(localRoot, "logs", `p2-capture-${label}-${startedAt.replaceAll(":", "-")}.log`));
  const result: Json = { createdAt: startedAt, label, turns: {} };
  try {
    await server.initialize();
    const { thread } = await server.request<{ thread: Json }>("thread/start", { model: TEST_MODEL, cwd: workDir, approvalPolicy: "never", sandbox: "read-only", ephemeral: false });
    result.threadId = thread.id;
    await server.request("thread/name/set", { threadId: thread.id, name: `[CAM测试] P2-1 请求结构 ${label}` });
    result.turns.upload = await runTurn(server, thread.id, [text("这是三张测试图，先不用描述，只回复“收到”。"), ...["a.png", "b.png", "b-copy.png"].map((name) => ({ type: "localImage", path: file(name) }))]);
    result.turns.viewImage = await runTurn(server, thread.id, [text(`请用 view_image 工具查看这个文件：${file("c.png")}，然后用一句话说出它的背景色和主要形状。`)]);
    result.turns.generate = await runTurn(server, thread.id, [text("请用内置的生图工具生成一张简单的图片：浅绿色背景，正中间一个橙色正方形。生成 1 张即可。")]);
    result.turns.last = await runTurn(server, thread.id, [text("请只回复“好的”。")]);
  } finally {
    await server.stop();
    writeFileSync(join(localRoot, "p2", `capture-${label}.json`), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result, (key, value) => (key === "reply" && typeof value === "string" ? value.slice(0, 160) : value), 2));
  }
}

await main();
