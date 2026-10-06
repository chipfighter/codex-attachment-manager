// Purpose: v0.3 — automatic selection end to end (spec v0.3, acceptance 3 and 4): with the switch on, does the model
// fetch an omitted image with cam_view_image when the answer needs it, leave the tool alone when what it said before is
// enough, and answer from what it fetched? Is the copy recognized and left out of the next turn?
// A test engine of this checkout (its own port and data folder) rewrites the requests; this checkout's plugin server is
// attached to the test app-server as an MCP server of its own (engine supervision off), for cam_view_image. The switch
// is set in the test's selection file, as the panel would set it. Computer use, the browsers and the other plugins that
// act on the machine are off, the sandbox is read-only, and the tasks are archived at the end.
// Thread A asks outright for a fetch; thread B asks questions that need an image or do not; thread C has one image, so
// nothing else in the context can mislead the reading. Each test image hides a digit in a corner that the descriptions
// leave out. Drafts of the wording were tried the same way before it was built, with the rewrite done by a stand-in.
// Input: [--label name] [--lang zh|en] [--port 17897] [--threads A,B,C]; CAM_TEST_MODEL, CAM_TEST_EFFORT.
// Output: local/v03/auto-<label>.json (synthetic images only).

import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { AppServer, findBundledCodex } from "./appserver.ts";
import { codexHome } from "../../plugin/src/codexconfig.ts";
import { engineHealth } from "../../plugin/src/engine.ts";
import { languageFileOf, rememberLang, type Lang } from "../../plugin/src/language.ts";
import { requestStatsDirOf, selectionDirOf } from "../../plugin/src/paths.ts";
import { readRequestStats } from "../../plugin/src/request-stats.ts";
import { writeSelection } from "../../plugin/src/selection.ts";
import { loadThreadIndex } from "../../plugin/src/thread-index.ts";
import { archiveThreads, png, runTurn, TEST_EFFORT, TEST_MODEL, text } from "./testkit.ts";

type Json = Record<string, any>;
const here = dirname(fileURLToPath(import.meta.url));
const localRoot = join(resolve(here, "../.."), "local");

// ---- test images: a background, a shape in the middle, and a digit in one corner
const FONT: Record<string, string[]> = {
  "3": ["11111", "00010", "00100", "00010", "00001", "10001", "01110"],
  "5": ["11111", "10000", "11110", "00001", "00001", "10001", "01110"],
  "7": ["11111", "00001", "00010", "00100", "01000", "01000", "01000"],
};
const digit = (ch: string, left: number, top: number, scale = 8) => (x: number, y: number) => {
  const col = Math.floor((x - left) / scale);
  const row = Math.floor((y - top) / scale);
  return x >= left && y >= top && col < 5 && row < 7 && FONT[ch][row][col] === "1";
};
const IMAGES: Record<string, () => Buffer> = {
  // White, a red square in the middle, a black 7 in the bottom-right corner.
  "a.png": () => { const seven = digit("7", 440, 420); return png(512, 512, (x, y) => (seven(x, y) ? [0, 0, 0] : x >= 136 && x < 376 && y >= 136 && y < 376 ? [220, 30, 30] : [255, 255, 255])); },
  // Yellow, a blue disc in the middle, a green 3 in the top-left corner.
  "b.png": () => { const three = digit("3", 30, 30); return png(512, 512, (x, y) => (three(x, y) ? [20, 120, 40] : (x - 256) ** 2 + (y - 256) ** 2 < 130 ** 2 ? [40, 70, 210] : [250, 220, 60])); },
  // Purple, a white triangle pointing up, an orange 5 in the top-right corner.
  "c.png": () => { const five = digit("5", 442, 30); return png(512, 512, (x, y) => (five(x, y) ? [250, 140, 20] : y > 120 && y < 400 && Math.abs(x - 256) < (y - 120) * 0.6 ? [255, 255, 255] : [120, 50, 160])); },
};

const SCRIPT = {
  zh: {
    name: (label: string, thread: string) => `[CAM测试] 自动选图自测 ${thread} ${label}`,
    uploadOne: "这是一张测试图，先不用描述，只回复“收到”。",
    explicit: "请调用 cam_view_image 工具查看 IMG-001，然后告诉我图片右下角的数字是几。",
    again: "IMG-001 右下角的数字是几？",
    uploadThree: "这是三张测试图，先不用描述，只回复“收到”。",
    describe: "分别用一句话说说这三张图的背景色和中间的主要形状。只说这两样，不要提角落里的东西。",
    recall: "b.png 的背景是什么颜色？中间是什么形状？",
    detail: "a.png 的右下角有一个数字，是几？",
    byLook: "那张紫色背景的图，右上角的数字是几？",
    textOnly: "把“今天天气很好”翻译成英文。",
    sum: "黄色背景那张图左上角的数字，和 a.png 右下角的数字，加起来是多少？",
    corner: "这张图右上角的数字是几？",
    recallWords: [/黄/, /圆/],
  },
  en: {
    name: (label: string, thread: string) => `[CAM test] auto image selection ${thread} ${label}`,
    uploadOne: "Here is a test image. Don't describe it yet; just reply \"received\".",
    explicit: "Please call the cam_view_image tool to view IMG-001, then tell me the number in the bottom-right corner of the image.",
    again: "What is the number in the bottom-right corner of IMG-001?",
    uploadThree: "Here are three test images. Don't describe them yet; just reply \"received\".",
    describe: "In one sentence each, give the background color and the main shape in the middle of these three images. Only those two things: don't mention anything in the corners.",
    recall: "What is the background color of b.png, and what shape is in the middle?",
    detail: "There is a number in the bottom-right corner of a.png. What is it?",
    byLook: "In the image with the purple background, what is the number in the top-right corner?",
    textOnly: "Translate \"今天天气很好\" into English.",
    sum: "What do the number in the top-left corner of the yellow image and the number in the bottom-right corner of a.png add up to?",
    corner: "What is the number in the top-right corner of this image?",
    recallWords: [/yellow/i, /circle|disc|disk/i],
  },
};

// A number in the reply, as a numeral or a word, ignoring image ids.
const NUMBER_WORDS: Record<number, RegExp> = { 3: /三|three/i, 5: /五|five/i, 7: /七|seven/i, 10: /十|ten\b/i };
const says = (reply: string, n: number) => {
  const clean = reply.replace(/IMG-\d{3}/g, "");
  return new RegExp(`(^|[^0-9])${n}([^0-9]|$)`).test(clean) || NUMBER_WORDS[n].test(clean);
};

async function main(): Promise<void> {
  const option = (name: string, fallback: string) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : fallback);
  const label = option("--label", "run1");
  const lang: Lang = option("--lang", "zh") === "en" ? "en" : "zh";
  const port = Number(option("--port", "17897"));
  const only = option("--threads", "A,B,C").split(",");
  const words = SCRIPT[lang];
  const root = join(localRoot, "v03");
  const data = join(root, `data-${label}`);
  // A folder per run, so runs side by side never rewrite an image another one is uploading.
  const work = join(root, "work", label);
  mkdirSync(work, { recursive: true });
  for (const [name, draw] of Object.entries(IMAGES)) writeFileSync(join(work, name), draw());
  // What the panel would have told the plugin: Codex shows this language.
  rememberLang(lang, "codex", languageFileOf(data));
  const sessionsDir = join(codexHome(), "sessions");

  const engine = spawn(process.execPath, [join(here, "..", "..", "plugin", "src", "proxy.ts"), "--port", String(port), "--stay"], { env: { ...process.env, CAM_DATA_DIR: data }, stdio: "ignore", windowsHide: true });
  for (let i = 0; i < 50 && !(await engineHealth(port)); i++) await sleep(200);
  // Nothing that acts on the machine: no computer use, browsers or app tools, no notify program.
  const off = ["computer-use@openai-bundled", "unified-computer-use@openai-bundled", "chrome@openai-bundled", "browser@openai-bundled", "codex-app-tools@openai-bundled"]
    .flatMap((plugin) => ["-c", `plugins.${plugin}.enabled=false`]);
  // This checkout's plugin server, for cam_view_image; it reads the same data folder as the test engine.
  const env = { CODEX_HOME: codexHome(), CAM_DATA_DIR: data, CAM_NO_ENGINE: "1" };
  const plugin = [
    "-c", `mcp_servers.cam_dev.command=${JSON.stringify(process.execPath)}`,
    "-c", `mcp_servers.cam_dev.args=${JSON.stringify([join(here, "..", "..", "plugin", "src", "plugin-server.ts")])}`,
    "-c", `mcp_servers.cam_dev.env={ ${Object.entries(env).map(([name, value]) => `${name} = ${JSON.stringify(value)}`).join(", ")} }`,
    "-c", `mcp_servers.cam_dev.default_tools_approval_mode="approve"`,
    "-c", "mcp_servers.cam_dev.startup_timeout_sec=20",
  ];
  const server = new AppServer(findBundledCodex(), ["-c", `openai_base_url="http://localhost:${port}/backend-api/codex"`, "-c", "features.respect_system_proxy=true", "-c", "notify=[]", "-c", "mcp_servers.node_repl.enabled=false", ...off, ...plugin], { NO_PROXY: undefined, no_proxy: undefined }, join(root, `appserver-${label}.log`));
  const result: Json = { createdAt: new Date().toISOString(), label, lang, model: TEST_MODEL, effort: TEST_EFFORT, threads: {} };
  const created: string[] = [];
  try {
    await server.initialize();
    const start = async (name: string) => {
      const { thread } = await server.request<{ thread: Json }>("thread/start", { model: TEST_MODEL, cwd: work, approvalPolicy: "never", sandbox: "read-only", ephemeral: false });
      created.push(thread.id);
      await server.request("thread/name/set", { threadId: thread.id, name: words.name(label, name) });
      return thread.id as string;
    };
    // As the panel's switch does.
    const switchOn = async (threadId: string) => {
      const at = new Date().toISOString();
      writeSelection({ threadId, unchecked: {}, auto: true, autoAt: at, autoSince: at }, selectionDirOf(data));
      await sleep(2500);
    };
    // A turn, what the model fetched in it (the copies the index found there) and what the engine did to its last request.
    const turn = async (threadId: string, prompt: string, images: string[] = []) => {
      const done = await runTurn(server, threadId, [text(prompt), ...images.map((file) => ({ type: "localImage", path: join(work, file) }))]);
      // The engine records a request once its response has ended, which can be just after the turn completes.
      await sleep(1500);
      const index = loadThreadIndex(sessionsDir, threadId);
      const number = index.turnNumbers.get(done.turnId) ?? null;
      const fetched = [...new Set([...index.copies.values()].filter((copy) => copy.turn === number).map((copy) => copy.of))];
      const rewrite = readRequestStats(threadId, requestStatsDirOf(data))?.lastHttp?.rewrite ?? null;
      return { ...done, fetched, lastRewrite: rewrite && { auto: rewrite.auto ?? false, replaced: (rewrite.replaced ?? []).map((r: Json) => `${r.id}:${r.mode}`), copies: rewrite.copies ?? [] } };
    };
    const threads: Record<string, () => Promise<Json>> = {
      A: async () => {
        const id = await start("A");
        const turns: Json = { upload: await turn(id, words.uploadOne, ["a.png"]) };
        await switchOn(id);
        turns.explicit = await turn(id, words.explicit);
        turns.again = await turn(id, words.again);
        return { threadId: id, turns, images: loadThreadIndex(sessionsDir, id).images.map((image) => image.id) };
      },
      B: async () => {
        const id = await start("B");
        const turns: Json = { upload: await turn(id, words.uploadThree, ["a.png", "b.png", "c.png"]) };
        turns.describe = await turn(id, words.describe);
        await switchOn(id);
        for (const name of ["recall", "detail", "byLook", "textOnly", "sum"] as const) turns[name] = await turn(id, words[name]);
        return { threadId: id, turns, images: loadThreadIndex(sessionsDir, id).images.map((image) => image.id) };
      },
      C: async () => {
        const id = await start("C");
        const turns: Json = { upload: await turn(id, words.uploadOne, ["c.png"]) };
        await switchOn(id);
        turns.corner = await turn(id, words.corner);
        return { threadId: id, turns };
      },
    };
    for (const name of only) if (threads[name]) result.threads[name] = await threads[name]();
  } finally {
    result.notArchived = await archiveThreads(server, created);
    await server.stop();
    engine.kill();
  }

  const A = result.threads.A?.turns ?? {};
  const B = result.threads.B?.turns ?? {};
  const C = result.threads.C?.turns ?? {};
  const reply = (t: Json) => String(t?.reply ?? "");
  const ran = (name: string) => !!result.threads[name];
  result.checks = {
    ...(ran("A") ? {
      A_explicitFetchesImg001: A.explicit.fetched.includes("IMG-001"),
      A_explicitAnswers7: says(reply(A.explicit), 7),
      // The copy is no image of its own, and the next turn's requests leave it out.
      A_copyHasNoId: JSON.stringify(result.threads.A.images) === JSON.stringify(["IMG-001"]),
      A_copyLeftOutNextTurn: !!A.again.lastRewrite?.copies.includes("IMG-001"),
      A_againAnswers7: says(reply(A.again), 7),
    } : {}),
    ...(ran("B") ? {
      B_earlierTurnsLeftOut: !!B.recall.lastRewrite?.auto && ["IMG-001", "IMG-002", "IMG-003"].every((id) => B.recall.lastRewrite.replaced.includes(`${id}:plain`)),
      B_recallNoFetch: B.recall.fetched.length === 0 && words.recallWords.every((word) => word.test(reply(B.recall))),
      B_detailFetchesImg001: B.detail.fetched.includes("IMG-001"),
      B_detailAnswers7: says(reply(B.detail), 7),
      B_byLookFetchesImg003: B.byLook.fetched.includes("IMG-003"),
      B_byLookAnswers5: says(reply(B.byLook), 5),
      B_textOnlyNoFetch: B.textOnly.fetched.length === 0,
      B_sumFetchesImg002: B.sum.fetched.includes("IMG-002"),
      B_sumAnswers10: says(reply(B.sum), 10),
    } : {}),
    ...(ran("C") ? {
      C_cornerFetchesImg001: C.corner.fetched.includes("IMG-001"),
      C_cornerAnswers5: says(reply(C.corner), 5),
    } : {}),
    noErrors: [...Object.values(A), ...Object.values(B), ...Object.values(C)].every((t: Json) => t.status === "completed" && !t.errors.length),
  };
  // Fetching an image it already answered about is not wrong, only slower.
  result.notes = { refetched: [A.again?.fetched.length ? "A.again" : null, B.sum?.fetched.includes("IMG-001") ? "B.sum" : null].filter(Boolean) };
  writeFileSync(join(root, `auto-${label}.json`), JSON.stringify(result, null, 2));
  const brief = (t: Json) => ({ fetched: t.fetched, reply: t.reply });
  console.log(JSON.stringify({
    model: `${TEST_MODEL} ${TEST_EFFORT}`, lang, checks: result.checks, notes: result.notes, notArchived: result.notArchived,
    turns: Object.fromEntries(Object.entries(result.threads as Record<string, Json>).map(([name, thread]) => [name, Object.fromEntries(Object.entries(thread.turns as Record<string, Json>).map(([key, t]) => [key, brief(t)]))])),
  }, null, 2));
}

await main();
