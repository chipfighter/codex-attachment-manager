// Purpose: v0.1-14 — the plugin speaks Simplified Chinese or English: which language a tag or the system gives, the
// language the panel reports is remembered, every text exists in both languages with the same {values}, and the text
// for the model and the plugin's answers follow the language.
// Input: synthetic tags, environments and temporary data folders; output: Node test assertions only.

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { currentLang, langOf, rememberLang, storedLang, systemLang } from "../../plugin/src/language.ts";
import { MESSAGES, say } from "../../plugin/src/messages.ts";
import { callTool, toolsFor } from "../../plugin/src/plugin-server.ts";
import { OMISSION_NOTE, omissionNote, rewriteItems, type Described } from "../../plugin/src/rewrite.ts";
import { sampleSessions } from "./testfixtures.ts";

const here = dirname(fileURLToPath(import.meta.url));
const valuesOf = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();

test("any Chinese is Simplified Chinese, anything else English; locale variables come before the runtime", () => {
  assert.deepEqual(["zh-CN", "zh-TW", "zh_HK.UTF-8", "ZH", "en-US", "fr-FR", "ja", "", "C", "POSIX", "C.UTF-8", null].map(langOf), ["zh", "zh", "zh", "zh", "en", "en", "en", null, null, null, null, null]);
  assert.equal(systemLang({ LANG: "zh_CN.UTF-8" }), "zh");
  assert.equal(systemLang({ LC_ALL: "en_US.UTF-8", LANG: "zh_CN.UTF-8" }), "en", "LC_ALL wins");
  assert.equal(systemLang({ LANG: "C" }), langOf(Intl.DateTimeFormat().resolvedOptions().locale) ?? "en", "C says nothing: the runtime decides");
});

test("the language a panel reports is kept, with where it came from; without one the system decides", () => {
  const file = join(mkdtempSync(join(tmpdir(), "cam-lang-")), "language.json");
  assert.equal(storedLang(file), null);
  assert.equal(currentLang(file), systemLang());
  rememberLang("en", "codex", file);
  assert.deepEqual([storedLang(file)?.lang, storedLang(file)?.source], ["en", "codex"]);
  assert.equal(currentLang(file), "en");
  const written = readFileSync(file, "utf8");
  rememberLang("en", "codex", file);
  assert.equal(readFileSync(file, "utf8"), written, "unchanged: not written again");
  rememberLang("zh", "system", file);
  assert.deepEqual([currentLang(file), storedLang(file)?.source], ["zh", "system"]);
  process.env.CAM_LANG = "en";
  try { assert.deepEqual([currentLang(file), systemLang({ CAM_LANG: "en", LANG: "zh_CN.UTF-8" })], ["en", "en"], "CAM_LANG fixes it (tests, development)"); } finally { delete process.env.CAM_LANG; }
});

test("the plugin's texts exist in both languages with the same {values}", () => {
  assert.deepEqual(Object.keys(MESSAGES.en).sort(), Object.keys(MESSAGES.zh).sort());
  for (const key of Object.keys(MESSAGES.zh) as Array<keyof typeof MESSAGES.zh>) assert.deepEqual(valuesOf(MESSAGES.en[key]), valuesOf(MESSAGES.zh[key]), key);
  assert.equal(say("zh", "call.summary", { images: 3, unchecked: 1 }), "共 3 张图，取消了 1 张。");
  assert.equal(say("en", "call.summary", { images: 3, unchecked: 1 }), "Images: 3, unchecked: 1.");
});

test("the panel's texts exist in both languages with the same {values}; English may add a form for one", () => {
  const page = readFileSync(join(here, "..", "..", "plugin", "src", "panel.html"), "utf8");
  const table = JSON.parse(/<script type="application\/json" id="messages">([\s\S]*?)<\/script>/.exec(page)![1]);
  const base = (keys: string[]) => keys.filter((key) => !key.endsWith("_one")).sort();
  assert.deepEqual(base(Object.keys(table.en)), base(Object.keys(table.zh)));
  for (const key of Object.keys(table.en)) assert.deepEqual(valuesOf(table.en[key]), valuesOf(table.zh[key.replace(/_one$/, "")]), key);
  assert.ok(Object.keys(table.zh).length > 70);
});

test("the tab's title and the tools speak the language; the panel's calls are answered in its language", () => {
  assert.deepEqual([toolsFor("zh")[0].title, toolsFor("en")[0].title], ["上下文素材", "Context Assets"]);
  const { sessionsDir, dataRoot } = sampleSessions();
  process.env.CAM_DATA_DIR = dataRoot;
  try {
    const model = { "x-codex-turn-metadata": { thread_id: "01a0d301-0000-7000-8000-00000000abcd" } };
    assert.throws(() => callTool("cam_set_selection", { uncheck: ["IMG-001"], lang: "en" }, model, sessionsDir), /Only the user can check or uncheck images; if you need an image, reply "need IMG-xxx"/);
    const panel = { threadId: "01a0d301-0000-7000-8000-00000000abcd" };
    assert.equal(callTool("cam_panel", { lang: "en", langSource: "codex" }, panel, sessionsDir).content[0].text, "Images: 3, unchecked: 0.");
    assert.deepEqual([storedLang(join(dataRoot, "language.json"))?.lang, storedLang(join(dataRoot, "language.json"))?.source], ["en", "codex"], "remembered for the engine");
    assert.equal(callTool("cam_panel", {}, panel, sessionsDir).content[0].text, "Images: 3, unchecked: 0.", "a call without a language gets the remembered one");
  } finally {
    delete process.env.CAM_DATA_DIR;
  }
});

test("the text for the model follows the language; the Chinese is the one tested on 2026-09-25", () => {
  assert.equal(omissionNote("zh"), OMISSION_NOTE);
  const en = omissionNote("en");
  assert.match(en, /really existed in the turn where they appeared/);
  assert.match(en, /do not take them back or apologize/);
  assert.match(en, /need IMG-xxx/);
  assert.doesNotMatch(en, /[一-鿿]/);
  const image = (id: string) => ({ type: "input_image", image_url: `data:image/png;base64,${Buffer.from(id).toString("base64")}` });
  const input = [{ type: "message", id: "msg_1", role: "user", content: [{ type: "input_text", text: "look" }, image("a")] }];
  const described: Described = { id: "IMG-001", name: "a.png", label: null, kind: "upload", turn: 1, width: 4, height: 4 };
  const run = (lang: "zh" | "en") => rewriteItems(input, () => described, new Set(["msg_1#0"]), () => null, lang).items;
  const english = JSON.stringify(run("en"));
  assert.match(english, /\[Image IMG-001 omitted \| a\.png \| uploaded by the user \| turn 1 \| 4×4\]/);
  assert.match(english, /write \\"need IMG-001\\" in your reply/);
  assert.doesNotMatch(english, /[一-鿿]/);
  assert.match(JSON.stringify(run("zh")), /\[图片 IMG-001 已省略｜a\.png｜用户上传｜第 1 轮｜4×4\]/);
});
