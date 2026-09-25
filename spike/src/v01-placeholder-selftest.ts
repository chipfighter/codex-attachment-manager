// Purpose: v0.1 — does unchecking an image the model already described make it doubt itself? Replays the user's
// report of 2026-09-25 with the new placeholder wording: see the image → describe it → uncheck it → "can you see it?"
// → recall the earlier description → ask a detail never described (must ask for the image instead of guessing).
// Runs a test engine of this checkout on its own port and data folder, so the user's running engine is not touched.
// v0.1-14 — --lang en runs the same turns in English, with the engine told the panel shows English, so the English
// text for the model is checked the same way.
// Input: [--label name] [--port 17899] [--lang zh|en]. Output: local/v01/placeholder-<label>.json (synthetic test thread
// only).

import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { AppServer, findBundledCodex } from "./appserver.ts";
import { codexHome } from "../../plugin/src/codexconfig.ts";
import { engineHealth } from "../../plugin/src/engine.ts";
import { languageFileOf, rememberLang } from "../../plugin/src/language.ts";
import { selectionDirOf } from "../../plugin/src/paths.ts";
import { readRequestStats } from "../../plugin/src/request-stats.ts";
import { writeSelection } from "../../plugin/src/selection.ts";
import { runTurn, TEST_MODEL, testImages, text } from "./testkit.ts";
import { loadThreadIndex } from "../../plugin/src/thread-index.ts";

type Json = Record<string, any>;
const here = dirname(fileURLToPath(import.meta.url));
const localRoot = join(resolve(here, "../.."), "local");
// Taking back an earlier answer, in the ways the model phrased it in the report (and their English counterparts).
const RETRACTION = /猜|不可靠|没有依据|错误回答|说错|抱歉|收回|撤回|并不准确/;
const RETRACTION_EN = /\b(guess(ed|ing)?|unreliable|no basis|mistaken|was wrong|incorrect|apologi[sz]e|sorry|take (it|that|them) back|retract)/i;

// The five turns and what each reply must show, per language.
const SCRIPT = {
  zh: {
    name: (label: string) => `[CAM测试] v0.1 占位符自测 ${label}`,
    upload: "这是两张测试图，先不用描述，只回复“收到”。",
    describe: "a.png 是什么背景色、什么主要形状？角落里有什么小标记，在哪个角？不要调用任何工具。",
    canYouSee: "现在能看到a.png吗？",
    recall: "你刚才说 a.png 的背景是什么颜色、中间是什么形状？",
    newDetail: "a.png 里那个红色正方形的四个角，是直角还是圆角？",
    colors: [/白/, /红/, /黑/],
    recalled: [/白/, /(方|正方)/],
    retraction: RETRACTION,
    asks: (id: string) => new RegExp(`需要\\s*${id}`),
  },
  en: {
    name: (label: string) => `[CAM test] v0.1 placeholder self-test ${label}`,
    upload: "Here are two test images. Don't describe them yet; just reply \"received\".",
    describe: "What is the background color of a.png, and what is its main shape? What small mark is in a corner, and which corner? Do not call any tools.",
    canYouSee: "Can you see a.png now?",
    recall: "What did you say earlier about the background color of a.png and the shape in the middle?",
    newDetail: "Are the four corners of the red square in a.png sharp right angles or rounded?",
    colors: [/white/i, /red/i, /black/i],
    recalled: [/white/i, /square/i],
    retraction: RETRACTION_EN,
    asks: (id: string) => new RegExp(`need\\s*["“]?${id}`, "i"),
  },
};

async function main(): Promise<void> {
  const option = (name: string, fallback: string) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : fallback);
  const label = option("--label", "run1");
  const port = Number(option("--port", "17899"));
  const lang = option("--lang", "zh") === "en" ? "en" : "zh";
  const words = SCRIPT[lang];
  const root = join(localRoot, "v01");
  const data = join(root, `data-${label}`);
  const work = join(root, "work");
  mkdirSync(work, { recursive: true });
  writeFileSync(join(work, "a.png"), testImages.redSquare());
  writeFileSync(join(work, "b.png"), testImages.blueCircle());
  // What the panel would have told the plugin: Codex shows this language.
  rememberLang(lang, "codex", languageFileOf(data));

  const engine = spawn(process.execPath, [join(here, "..", "..", "plugin", "src", "proxy.ts"), "--port", String(port), "--stay"], { env: { ...process.env, CAM_DATA_DIR: data }, stdio: "ignore", windowsHide: true });
  for (let i = 0; i < 50 && !(await engineHealth(port)); i++) await sleep(200);
  const startedAt = new Date().toISOString();
  const server = new AppServer(findBundledCodex(), ["-c", `openai_base_url="http://localhost:${port}/backend-api/codex"`, "-c", "features.respect_system_proxy=true"], { NO_PROXY: undefined, no_proxy: undefined }, join(root, `appserver-${label}.log`));
  const result: Json = { createdAt: startedAt, label, lang, turns: {} };
  try {
    await server.initialize();
    const { thread } = await server.request<{ thread: Json }>("thread/start", { model: TEST_MODEL, cwd: work, approvalPolicy: "never", sandbox: "read-only", ephemeral: false });
    const threadId: string = thread.id;
    result.threadId = threadId;
    await server.request("thread/name/set", { threadId, name: words.name(label) });
    const turn = async (name: string, prompt: string, images: string[] = []) => {
      result.turns[name] = await runTurn(server, threadId, [text(prompt), ...images.map((file) => ({ type: "localImage", path: join(work, file) }))]);
    };

    await turn("upload", words.upload, ["a.png", "b.png"]);
    await turn("describe", words.describe);
    const index = loadThreadIndex(join(codexHome(), "sessions"), threadId);
    const a = index.images.find((image) => image.name === "a.png")!;
    result.aId = a.id;
    writeSelection({ threadId, unchecked: { [a.key]: { id: a.id, at: new Date().toISOString() } } }, selectionDirOf(data));
    await sleep(2500);
    await turn("canYouSee", words.canYouSee);
    await turn("recall", words.recall);
    await turn("newDetail", words.newDetail);
    result.lastRequest = readRequestStats(threadId, join(data, "state", "requests"))?.lastHttp?.rewrite ?? null;
  } finally {
    await server.stop();
    engine.kill();
  }

  const reply = (name: string) => String(result.turns[name]?.reply ?? "");
  result.checks = {
    describeSeesImage: words.colors.every((color) => color.test(reply("describe"))),
    canYouSeeNoRetraction: !words.retraction.test(reply("canYouSee")),
    recallKeepsEarlierAnswer: words.recalled.every((word) => word.test(reply("recall"))) && !words.retraction.test(reply("recall")),
    newDetailAsksForImage: words.asks(result.aId).test(reply("newDetail")),
    lastRequestReplacedA: JSON.stringify(result.lastRequest?.replaced?.map((r: Json) => `${r.id}:${r.mode}`)) === JSON.stringify([`${result.aId}:plain`]),
    noErrors: Object.values(result.turns as Record<string, Json>).every((t) => t.status === "completed" && !t.errors.length),
  };
  writeFileSync(join(root, `placeholder-${label}.json`), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ threadId: result.threadId, checks: result.checks, replies: Object.fromEntries(Object.entries(result.turns as Record<string, Json>).map(([name, t]) => [name, t.reply])) }, null, 2));
}

await main();
