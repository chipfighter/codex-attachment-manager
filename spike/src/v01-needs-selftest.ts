// Purpose: v0.1-17 follow-up — when the images the model needs are unnamed screenshots it took with a tool (as with
// computer use) and the user unchecked them all, does it ask for them by id ("需要 IMG-xxx")? Replays the shape of the
// user's report of 2026-09-26: the model changed a setting in a desktop app, taking screenshots after each step (each
// call has a title, no screenshot has a name, and the model never described them); later all of them are unchecked.
// Thread 1 asks what the user asked then ("can you look at the images, how are the settings now?", "which images do
// you need?"), then a detail only an old screenshot shows; thread 2 asks only that detail, in a fresh context.
// The history is given to app-server's thread/resume (history: an unstable parameter), which starts a new thread
// holding it. Computer use, the browsers and the other plugins that act on the machine are switched off for this
// app-server, and it runs read-only with no approvals, so nothing on the machine is touched.
// Input: [--label name] [--port 17898] [--lang zh|en]. Output: local/v01/needs-<label>.json (synthetic threads only).

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { AppServer, findBundledCodex } from "./appserver.ts";
import { codexHome } from "../../plugin/src/codexconfig.ts";
import { engineHealth } from "../../plugin/src/engine.ts";
import { languageFileOf, rememberLang } from "../../plugin/src/language.ts";
import { askedIn } from "../../plugin/src/panel-state.ts";
import { selectionDirOf } from "../../plugin/src/paths.ts";
import { readRequestStats } from "../../plugin/src/request-stats.ts";
import { writeSelection } from "../../plugin/src/selection.ts";
import { loadThreadIndex } from "../../plugin/src/thread-index.ts";
import { png, runTurn, TEST_MODEL, text } from "./testkit.ts";

type Json = Record<string, any>;
const here = dirname(fileURLToPath(import.meta.url));
const localRoot = join(resolve(here, "../.."), "local");

// A 640×400 app window: title bar, a list on the left with one entry highlighted (or none), and one shape on the right.
type Rgb = [number, number, number];
function screen(selected: number | null, shape: (x: number, y: number) => boolean, color: Rgb): Buffer {
  return png(640, 400, (x, y) => {
    if (y < 28) return [45, 45, 50];
    if (shape(x, y)) return color;
    if (selected !== null && x < 150) return y >= 60 + selected * 36 && y < 90 + selected * 36 ? [70, 110, 200] : [235, 235, 238];
    return [250, 250, 250];
  });
}
const SHOTS = [
  // Main window: a dark preview area with a green disc in it.
  () => png(640, 400, (x, y) => (y < 28 ? [45, 45, 50] : x > 40 && x < 600 && y > 50 && y < 300 ? ((x - 320) ** 2 + (y - 175) ** 2 < 55 ** 2 ? [40, 200, 90] : [20, 20, 24]) : [230, 230, 232])),
  // Settings, first page: a red square.
  () => screen(0, (x, y) => x > 300 && x < 380 && y > 150 && y < 230, [220, 40, 40]),
  // Settings, output page: a blue bar.
  () => screen(1, (x, y) => x > 200 && x < 560 && y > 180 && y < 204, [40, 90, 220]),
  // Settings, video page: an orange triangle in the top-right corner.
  () => screen(2, (x, y) => y > 50 && y < 120 && x > 520 && Math.abs(x - 560) < (y - 50) * 0.6, [245, 140, 20]),
];

const SCRIPT = {
  zh: {
    name: (label: string, n: number) => `[CAM测试] 截图编号自测 ${label}-${n}`,
    ask: "帮我把这个录屏软件的录像保存路径改到 D:\\录像，改完告诉我。",
    plan: "我来打开软件，在设置里修改录像路径并核对。",
    titles: ["查看主界面", "打开设置对话框", "切到输出页", "填入新的录像路径", "切到视频页"],
    pathText: (path: string) => `录像路径 Value: ${path}`,
    done: "已经把录像路径改成 D:\\录像，也看过了视频设置页。",
    lookNow: "你能看看图片，现在设置如何的？",
    whichImages: "你需要哪些图片？",
    detail: "之前你截的视频设置页里，右上角那个图形是什么颜色？",
    newShots: /截图|截个图|截一张|发.{0,6}图|重新截/,
  },
  en: {
    name: (label: string, n: number) => `[CAM test] screenshot id self-test ${label}-${n}`,
    ask: "Please change this screen recorder's recording folder to D:\\Recordings and tell me when it's done.",
    plan: "I'll open the app, change the recording path in its settings, and check it.",
    titles: ["Look at the main window", "Open the settings dialog", "Go to the Output page", "Enter the new recording path", "Go to the Video page"],
    pathText: (path: string) => `Recording Path Value: ${path}`,
    done: "The recording path is now D:\\Recordings, and I also looked at the video settings page.",
    lookNow: "Can you look at the images? How are the settings now?",
    whichImages: "Which images do you need?",
    detail: "In the video settings page you took a screenshot of earlier, what color is the shape in the top-right corner?",
    newShots: /screenshot|send (me )?(a |an |the )?(new |fresh )?(image|picture)/i,
  },
};

// The history as Codex records it: the model's calls have titles; each screenshot is a tool output with no name.
function history(words: typeof SCRIPT.zh): Json[] {
  const url = (bytes: Buffer) => `data:image/png;base64,${bytes.toString("base64")}`;
  const call = (n: number, title: string, output: Json[]): Json[] => [
    { type: "custom_tool_call", status: "completed", call_id: `call_shot_${n}`, name: "exec", input: `const r=await tools.mcp__node_repl__js({code:"state=await sky.get_window_state({window:targetWindow,include_screenshot:${output.some((part) => part.type === "input_image")}});",title:${JSON.stringify(title)}}); for(const c of r.content||[]){if(c.type==="image") image(c); else if(c.type==="text") text(c.text)}` },
    { type: "custom_tool_call_output", call_id: `call_shot_${n}`, output: [{ type: "input_text", text: "Script completed\nWall time 1.0 seconds\nOutput:\n" }, ...output] },
  ];
  const shot = (i: number) => ({ type: "input_image", image_url: url(SHOTS[i]()) });
  return [
    { type: "message", role: "user", content: [{ type: "input_text", text: words.ask }] },
    { type: "message", role: "assistant", content: [{ type: "output_text", text: words.plan }] },
    ...call(1, words.titles[0], [shot(0)]),
    ...call(2, words.titles[1], [shot(1)]),
    ...call(3, words.titles[2], [{ type: "input_text", text: words.pathText("C:\\Users\\me\\Videos") }, shot(2)]),
    ...call(4, words.titles[3], [{ type: "input_text", text: words.pathText(words.ask.includes("D:\\录像") ? "D:\\录像" : "D:\\Recordings") }]),
    ...call(5, words.titles[4], [shot(3)]),
    { type: "message", role: "assistant", content: [{ type: "output_text", text: words.done }] },
  ];
}

async function main(): Promise<void> {
  const option = (name: string, fallback: string) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : fallback);
  const label = option("--label", "run1");
  const port = Number(option("--port", "17898"));
  const lang = option("--lang", "zh") === "en" ? "en" : "zh";
  const words = SCRIPT[lang];
  const root = join(localRoot, "v01");
  const data = join(root, `needs-data-${label}`);
  const work = join(root, "work");
  mkdirSync(work, { recursive: true });
  rememberLang(lang, "codex", languageFileOf(data));

  const engine = spawn(process.execPath, [join(here, "..", "..", "plugin", "src", "proxy.ts"), "--port", String(port), "--stay"], { env: { ...process.env, CAM_DATA_DIR: data }, stdio: "ignore", windowsHide: true });
  for (let i = 0; i < 50 && !(await engineHealth(port)); i++) await sleep(200);
  // Nothing that acts on the machine: no computer use, browsers or app tools, no notify program.
  const off = ["computer-use@openai-bundled", "unified-computer-use@openai-bundled", "chrome@openai-bundled", "browser@openai-bundled", "codex-app-tools@openai-bundled"]
    .flatMap((plugin) => ["-c", `plugins.${plugin}.enabled=false`]);
  const server = new AppServer(findBundledCodex(), ["-c", `openai_base_url="http://localhost:${port}/backend-api/codex"`, "-c", "features.respect_system_proxy=true", "-c", "notify=[]", "-c", "mcp_servers.node_repl.enabled=false", ...off], { NO_PROXY: undefined, no_proxy: undefined }, join(root, `needs-appserver-${label}.log`));
  const result: Json = { createdAt: new Date().toISOString(), label, lang, threads: [] };
  const sessionsDir = join(codexHome(), "sessions");
  try {
    // thread/resume takes a history only from a client that opts into the experimental API.
    await server.initialize({ experimentalApi: true, requestAttestation: false });
    // Starts a thread holding the history, with every screenshot unchecked, and asks the questions in turn.
    const run = async (n: number, questions: Array<[string, string]>) => {
      const { thread } = await server.request<{ thread: Json }>("thread/resume", { threadId: randomUUID(), history: history(words), model: TEST_MODEL, cwd: work, approvalPolicy: "never", sandbox: "read-only" });
      const threadId: string = thread.id;
      await server.request("thread/name/set", { threadId, name: words.name(label, n) });
      const entry: Json = { threadId, turns: {} };
      // The index comes from the thread's record; if Codex has not written it yet, one short turn (images still in) does.
      const indexed = async () => {
        for (let i = 0; i < 25; i++) {
          try { const index = loadThreadIndex(sessionsDir, threadId); if (index.images.length === SHOTS.length) return index; } catch { /* not written yet */ }
          await sleep(200);
        }
        return null;
      };
      let index = await indexed();
      if (!index) {
        entry.warmUp = await runTurn(server, threadId, [text(lang === "zh" ? "先不用做别的，只回复“好”。" : "Nothing else for now; just reply \"OK\".")]);
        index = await indexed();
      }
      if (!index) throw new Error(`thread ${threadId}: its screenshots never showed up in the index`);
      const unchecked = Object.fromEntries(index.images.map((image) => [image.key, { id: image.id, at: new Date().toISOString() }]));
      writeSelection({ threadId, unchecked }, selectionDirOf(data));
      await sleep(2500);
      entry.images = index.images.map((image) => `${image.id}:${image.kind}:${image.name ?? "-"}`);
      for (const [name, prompt] of questions) entry.turns[name] = await runTurn(server, threadId, [text(prompt)]);
      entry.lastRequest = readRequestStats(threadId, join(data, "state", "requests"))?.lastHttp?.rewrite ?? null;
      result.threads.push(entry);
      return entry;
    };
    await run(1, [["lookNow", words.lookNow], ["whichImages", words.whichImages], ["detail", words.detail]]);
    await run(2, [["detail", words.detail]]);
  } finally {
    await server.stop();
    engine.kill();
  }

  const summary = result.threads.map((entry: Json) => ({
    threadId: entry.threadId,
    warmUp: entry.warmUp ? entry.warmUp.reply : null,
    images: entry.images,
    replaced: entry.lastRequest?.replaced?.map((r: Json) => `${r.id}:${r.mode}`) ?? null,
    turns: Object.fromEntries(Object.entries(entry.turns as Record<string, Json>).map(([name, t]) => [name, {
      // What the panel picks up from this reply (its bar and tags), next to every id the reply mentions.
      panelSees: askedIn(String(t.reply)), ids: [...new Set(String(t.reply).match(/IMG-\d{3}/g) ?? [])], asksForNewShots: words.newShots.test(t.reply),
      tools: t.tools, status: t.status, errors: t.errors, reply: t.reply,
    }])),
  }));
  result.summary = summary;
  writeFileSync(join(root, `needs-${label}.json`), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(summary, null, 2));
}

await main();
