// Purpose: v0.1 — does unchecking an image the model already described make it doubt itself? Replays the user's
// report of 2026-09-25 with the new placeholder wording: see the image → describe it → uncheck it → "can you see it?"
// → recall the earlier description → ask a detail never described (must ask for the image instead of guessing).
// Runs a test engine of this checkout on its own port and data folder, so the user's running engine is not touched.
// Input: [--label name] [--port 17899]. Output: local/v01/placeholder-<label>.json (synthetic test thread only).

import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { AppServer, findBundledCodex } from "./appserver.ts";
import { codexHome } from "../../plugin/src/codexconfig.ts";
import { engineHealth } from "../../plugin/src/engine.ts";
import { selectionDirOf } from "../../plugin/src/paths.ts";
import { readRequestStats } from "../../plugin/src/request-stats.ts";
import { writeSelection } from "../../plugin/src/selection.ts";
import { runTurn, TEST_MODEL, testImages, text } from "./testkit.ts";
import { loadThreadIndex } from "../../plugin/src/thread-index.ts";

type Json = Record<string, any>;
const here = dirname(fileURLToPath(import.meta.url));
const localRoot = join(resolve(here, "../.."), "local");
// Taking back an earlier answer, in the ways the model phrased it in the report.
const RETRACTION = /猜|不可靠|没有依据|错误回答|说错|抱歉|收回|撤回|并不准确/;

async function main(): Promise<void> {
  const option = (name: string, fallback: string) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : fallback);
  const label = option("--label", "run1");
  const port = Number(option("--port", "17899"));
  const root = join(localRoot, "v01");
  const data = join(root, `data-${label}`);
  const work = join(root, "work");
  mkdirSync(work, { recursive: true });
  writeFileSync(join(work, "a.png"), testImages.redSquare());
  writeFileSync(join(work, "b.png"), testImages.blueCircle());

  const engine = spawn(process.execPath, [join(here, "..", "..", "plugin", "src", "proxy.ts"), "--port", String(port), "--stay"], { env: { ...process.env, CAM_DATA_DIR: data }, stdio: "ignore", windowsHide: true });
  for (let i = 0; i < 50 && !(await engineHealth(port)); i++) await sleep(200);
  const startedAt = new Date().toISOString();
  const server = new AppServer(findBundledCodex(), ["-c", `openai_base_url="http://localhost:${port}/backend-api/codex"`, "-c", "features.respect_system_proxy=true"], { NO_PROXY: undefined, no_proxy: undefined }, join(root, `appserver-${label}.log`));
  const result: Json = { createdAt: startedAt, label, turns: {} };
  try {
    await server.initialize();
    const { thread } = await server.request<{ thread: Json }>("thread/start", { model: TEST_MODEL, cwd: work, approvalPolicy: "never", sandbox: "read-only", ephemeral: false });
    const threadId: string = thread.id;
    result.threadId = threadId;
    await server.request("thread/name/set", { threadId, name: `[CAM测试] v0.1 占位符自测 ${label}` });
    const turn = async (name: string, prompt: string, images: string[] = []) => {
      result.turns[name] = await runTurn(server, threadId, [text(prompt), ...images.map((file) => ({ type: "localImage", path: join(work, file) }))]);
    };

    await turn("upload", "这是两张测试图，先不用描述，只回复“收到”。", ["a.png", "b.png"]);
    await turn("describe", "a.png 是什么背景色、什么主要形状？角落里有什么小标记，在哪个角？不要调用任何工具。");
    const index = loadThreadIndex(join(codexHome(), "sessions"), threadId);
    const a = index.images.find((image) => image.name === "a.png")!;
    result.aId = a.id;
    writeSelection({ threadId, unchecked: { [a.key]: { id: a.id, at: new Date().toISOString() } } }, selectionDirOf(data));
    await sleep(2500);
    await turn("canYouSee", "现在能看到a.png吗？");
    await turn("recall", "你刚才说 a.png 的背景是什么颜色、中间是什么形状？");
    await turn("newDetail", "a.png 里那个红色正方形的四个角，是直角还是圆角？");
    result.lastRequest = readRequestStats(threadId, join(data, "state", "requests"))?.lastHttp?.rewrite ?? null;
  } finally {
    await server.stop();
    engine.kill();
  }

  const reply = (name: string) => String(result.turns[name]?.reply ?? "");
  result.checks = {
    describeSeesImage: /白/.test(reply("describe")) && /红/.test(reply("describe")) && /黑/.test(reply("describe")),
    canYouSeeNoRetraction: !RETRACTION.test(reply("canYouSee")),
    recallKeepsEarlierAnswer: /白/.test(reply("recall")) && /(方|正方)/.test(reply("recall")) && !RETRACTION.test(reply("recall")),
    newDetailAsksForImage: new RegExp(`需要\\s*${result.aId}`).test(reply("newDetail")),
    lastRequestReplacedA: JSON.stringify(result.lastRequest?.replaced?.map((r: Json) => `${r.id}:${r.mode}`)) === JSON.stringify([`${result.aId}:plain`]),
    noErrors: Object.values(result.turns as Record<string, Json>).every((t) => t.status === "completed" && !t.errors.length),
  };
  writeFileSync(join(root, `placeholder-${label}.json`), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ threadId: result.threadId, checks: result.checks, replies: Object.fromEntries(Object.entries(result.turns as Record<string, Json>).map(([name, t]) => [name, t.reply])) }, null, 2));
}

await main();
