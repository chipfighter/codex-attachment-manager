// Purpose: P4 — develop and screenshot the panel without Codex. Serves a page that plays Codex's side panel (the
// MCP Apps host side of the bridge) around the real panel.html, and answers its tool calls with the real plugin
// server code over a synthetic thread of test images (no user material).
// Input: none; `node spike/scripts/panel-dev.ts [--port 17895]`. Output: http://127.0.0.1:<port>/
// (?theme=dark, ?solo=1 for the panel alone, ?demo=pending|preview for a state to screenshot, ?slow=1 for slow calls,
// ?stats=none|skipped|websocket for other engine statistics than a normal rewritten request, ?setup=off for a Codex that
// does not go through the engine yet, ?demo=disabled for right after 停用插件, ?thread=fresh for a task with no rollout;
// with &newtask=1 the user then starts one task — the panel switches to it — and with &newtask=2 two at once;
// ?thread=gap for a fork whose original task was deleted, v0.1-13; ?lang=en for Codex in English, v0.1-14;
// ?thread=many for a task with 45 images whose last reply asks for two unchecked ones, v0.1-17).
// The demo task has a name, as if the user had renamed it in Codex (v0.1-9).
// Everything is written to a temporary folder, including a Codex home of its own: nothing in the user's Codex home is
// read or changed, whatever is clicked.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { png, testImages } from "../src/testkit.ts";

const here = dirname(fileURLToPath(import.meta.url));
const port = Number(process.argv[process.argv.indexOf("--port") + 1]) || 17895;
const THREAD = "01a0d301-0000-7000-8000-00000000d0e5";

// ---- a synthetic thread: uploads, a viewed image, a generated one, a duplicate, a large one, a hosted result ----
const root = mkdtempSync(join(tmpdir(), "cam-panel-dev-"));
const day = join(root, "sessions", "2026", "09", "24");
mkdirSync(day, { recursive: true });
process.env.CAM_DATA_DIR = join(root, "data");
// A Codex home of its own, with the plugin installed, so 启用 / 停用 on this page never touch the real one.
const codexHomeDir = join(root, "codex-home");
mkdirSync(join(codexHomeDir, "plugins", "cache", "codex-attachment-manager", "codex-attachment-manager", "0.1.0"), { recursive: true });
writeFileSync(join(codexHomeDir, "config.toml"), `model = "gpt-6-sol"\n\n[plugins."codex-attachment-manager@codex-attachment-manager"]\nenabled = true\n`);
process.env.CODEX_HOME = codexHomeDir;
const url = (bytes: Buffer) => `data:image/png;base64,${bytes.toString("base64")}`;
const line = (type: string, payload: object) => `${JSON.stringify({ timestamp: "2026-09-24T10:00:00Z", type, payload })}\n`;
const turn = (id: string) => line("event_msg", { type: "task_started", turn_id: id });
const say = (text: string, turnId: string) => line("response_item", { type: "message", role: "assistant", content: [{ type: "output_text", text }], internal_chat_message_metadata_passthrough: { turn_id: turnId } });
const upload = (id: string, turnId: string, files: Array<[string, Buffer]>) => line("response_item", {
  type: "message", id, role: "user",
  content: [{ type: "input_text", text: "看看这些图" }, ...files.flatMap(([name, bytes], i) => [
    { type: "input_text", text: `<image name=[Image #${i + 1}] path="C:\\w\\${name}">` },
    { type: "input_image", image_url: url(bytes) },
    { type: "input_text", text: "</image>" },
  ])],
  internal_chat_message_metadata_passthrough: { turn_id: turnId },
});
const toolImage = (callId: string, input: string, bytes: Buffer, hint = "") =>
  line("response_item", { type: "custom_tool_call", call_id: callId, name: "exec", input }) +
  line("response_item", { type: "custom_tool_call_output", id: `ctco_${callId}`, call_id: callId, output: [{ type: "input_image", image_url: url(bytes) }, ...(hint ? [{ type: "input_text", text: hint }] : [])] });

const sunset = png(768, 512, (x, y) => (y > 330 + Math.sin(x / 40) * 12 ? [30, 40, 90] : (x - 384) ** 2 + (y - 330) ** 2 < 90 ** 2 ? [255, 200, 80] : [250 - y / 4, 120 + y / 5, 90 + y / 3]));
const screenshot = png(1280, 720, (x, y) => (y < 44 ? [32, 33, 36] : x < 240 ? [244, 244, 245] : y > 90 && y < 130 && x > 280 && x < 900 ? [220, 226, 240] : (y - 170) % 60 < 22 && x > 280 && x < 1100 && y > 160 ? [235, 235, 238] : [255, 255, 255]));
const blue = testImages.blueCircle();
writeFileSync(join(day, `rollout-2026-09-24T10-00-00-${THREAD}.jsonl`),
  line("session_meta", { id: THREAD }) +
  turn("t1") + upload("msg_1", "t1", [["red-square.png", testImages.redSquare()], ["blue-circle.png", blue]]) + say("收到两张图。", "t1") +
  turn("t2") + toolImage("c1", 'await tools.view_image({path:"D:\\\\shots\\\\triangle.png"})', testImages.whiteTriangle()) +
  toolImage("c2", 'const r = await tools.image_gen__imagegen({prompt:"sunset"}); generatedImage(r);', sunset, "Generated images are saved to C:\\g\\t as C:\\g\\t\\sunset.png by default.") + say("这是生成的日落图。", "t2") +
  turn("t3") + upload("msg_3", "t3", [["blue-circle-copy.png", blue], ["noise-1024.png", testImages.noise()]]) + say("收到。", "t3") +
  turn("t4") + upload("msg_4", "t4", [["settings-screenshot.png", screenshot]]) +
  line("response_item", { type: "image_generation_call", id: "ig_1", status: "completed", result: png(256, 256, (x, y) => [x, y, 180]).toString("base64") }) + say("需要 IMG-001 才能回答。", "t4"));

// ?thread=gap: a fork whose history starts in a page of a task that was deleted since.
const GAP = `${THREAD.slice(0, -4)}0a90`;
writeFileSync(join(day, `rollout-2026-09-24T11-00-00-${GAP}.jsonl`),
  line("session_meta", { id: GAP, forked_from_id: "01a0d301-0000-7000-8000-00000000dead", history_base: { thread_id: "01a0d301-0000-7000-8000-00000000dead", end_byte_offset: 4096 } }) +
  turn("g1") + upload("msg_g1", "g1", [["after-fork.png", sunset]]));

// ?thread=many: 45 images over 11 turns; two large ones (about 3 MB each) are unchecked and the last reply asks for them.
const MANY = `${THREAD.slice(0, -4)}a045`;
const noiseOf = (seed: number) => {
  let state = seed;
  const next = () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return state & 0xff; };
  return png(1024, 1024, () => [next(), next(), next()]);
};
let shot = 0;
const photo = (): [string, Buffer] => {
  const n = ++shot;
  if (n === 17 || n === 32) return [`scan-${n}.png`, noiseOf(n * 0x9e3779b1)];
  const [r, g, b] = [(n * 53) % 200 + 40, (n * 97) % 200 + 40, (n * 151) % 200 + 40];
  return [`product-${String(n).padStart(2, "0")}.png`, png(480, 320, (x, y) => {
    const inside = [(x - 240) ** 2 + (y - 160) ** 2 < 90 ** 2, Math.abs(x - 240) < 90 && Math.abs(y - 160) < 90, (x + y) % 60 < 30, y > 60 && y < 260 && Math.abs(x - 240) < (y - 60) * 0.6][n % 4];
    return inside ? [255 - r, 255 - g, 255 - b] : [r, g, b];
  })];
};
let manyLog = line("session_meta", { id: MANY });
[5, 4, 4, 5, 3, 4, 5, 4, 4, 4, 3].forEach((count, index) => {
  const id = `m${index + 1}`;
  manyLog += turn(id) + upload(`msg_${id}`, id, Array.from({ length: count }, photo)) + say(index === 10 ? "需要 IMG-017 和 IMG-032 才能比较这两版。" : "收到。", id);
});
writeFileSync(join(day, `rollout-2026-09-24T12-00-00-${MANY}.jsonl`), manyLog);

// Their names, as Codex keeps them next to the sessions folder (the panel's title).
writeFileSync(join(root, "session_index.jsonl"), `${JSON.stringify({ id: THREAD, thread_name: "海报配色调整", updated_at: "2026-09-24T10:00:00Z" })}
${JSON.stringify({ id: MANY, thread_name: "产品图批量修图", updated_at: "2026-09-24T12:00:00Z" })}
`);

// New tasks the user starts after opening the panel on a new chat (?newtask=): Codex files them in today's folder.
let started = 0;
function startTasks(count: number): void {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const today = join(root, "sessions", String(now.getFullYear()), pad(now.getMonth() + 1), pad(now.getDate()));
  mkdirSync(today, { recursive: true });
  const messages = ["把这张海报改成暖色调，标题再大一点", "另一个窗口里：整理一下设置页的截图"];
  for (let i = 0; i < count; i++) {
    const id = `01a0d301-0000-7000-8000-${String(++started).padStart(8, "0")}beef`;
    const at = new Date(Date.now() - (count - i) * 1000).toISOString();
    const first = (type: string, payload: object) => `${JSON.stringify({ timestamp: at, type, payload })}
`;
    writeFileSync(join(today, `rollout-${at.slice(0, 19).replace(/:/g, "-")}-${id}.jsonl`),
      first("session_meta", { id, timestamp: at, source: "vscode", thread_source: "user" }) + turn("n1") +
      line("event_msg", { type: "user_message", message: messages[i] }) + upload(`msg_n${started}`, "n1", [[i ? "settings.png" : "poster.png", i ? screenshot : sunset]]));
  }
}

const { callTool, resetSetupBaseline } = await import("../../plugin/src/plugin-server.ts");
const { imageSizesOf } = await import("../../plugin/src/proxy.ts");
const { recordRequest } = await import("../../plugin/src/request-stats.ts");
const { connectDirectly, useEngine } = await import("../../plugin/src/setup.ts");
const { requestStatsDirOf } = await import("../../plugin/src/paths.ts");
const sessionsDir = join(root, "sessions");
const meta = { threadId: THREAD, thread_id: THREAD };
// Start with the red square, the copy of the blue circle and the large noise image unchecked, so both placeholder
// kinds and a visible saving show.
callTool("cam_set_selection", { uncheck: ["IMG-001", "IMG-005", "IMG-006"] }, meta, sessionsDir);
const manyMeta = { threadId: MANY, thread_id: MANY };
callTool("cam_set_selection", { uncheck: ["IMG-005", "IMG-012", "IMG-017", "IMG-024", "IMG-032", "IMG-040"] }, manyMeta, sessionsDir);

// What the engine would have recorded: the last full request came in turn 3 (turn 4's images are new since) and had
// IMG-001, IMG-005 and IMG-006 replaced. ?stats=skipped|websocket|none shows the other cases.
function writeStats(kind: string): void {
  const dir = requestStatsDirOf(process.env.CAM_DATA_DIR);
  rmSync(join(dir, `${THREAD}.json`), { force: true });
  if (kind === "none") return;
  const items = readFileSync(join(day, `rollout-2026-09-24T10-00-00-${THREAD}.jsonl`), "utf8").trim().split("\n").map((raw) => JSON.parse(raw)).filter((record) => record.type === "response_item").map((record) => record.payload);
  const sizes = Object.fromEntries(Object.entries(imageSizesOf(items)).slice(0, 6));
  const imageChars = Object.values(sizes).reduce((sum, chars) => sum + chars, 0);
  const before = imageChars + 180_000;
  const replaced = [sizes["msg_1#0"], sizes["msg_3#0"], sizes["msg_3#1"]];
  const rewrite = kind === "skipped" ? { skipped: "thread index: Error: demo" } : { replaced: [{ id: "IMG-001" }, { id: "IMG-005" }, { id: "IMG-006" }], decodedBefore: before, decodedAfter: before - replaced.reduce((sum, chars) => sum + chars, 0) + 2100 };
  const at = new Date(Date.now() - 6 * 60_000).toISOString();
  recordRequest(THREAD, { at, transport: "http", turnId: "t3", decodedBytes: before, imageSizes: sizes, rewrite }, dir);
  if (kind === "websocket") recordRequest(THREAD, { at: new Date().toISOString(), transport: "websocket", event: "active-while-unchecked" }, dir);
}

// ---- the host page: a stand-in for Codex's side panel ----
const HOST = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>面板开发页</title><style>
  body { margin: 0; height: 100vh; display: flex; font: 13px system-ui, "Microsoft YaHei UI", sans-serif; background: #e9e9ec; }
  body.dark { background: #0f0f0f; color: #eee; }
  .chat { flex: 1; display: flex; align-items: center; justify-content: center; color: #999; }
  .panel { width: var(--w, 420px); display: flex; flex-direction: column; border-left: 1px solid rgba(0,0,0,.12); background: #fff; }
  body.dark .panel { background: #181818; border-color: rgba(255,255,255,.1); }
  .tabs { height: 38px; display: flex; align-items: center; gap: 6px; padding: 0 10px; border-bottom: 1px solid rgba(0,0,0,.08); font-size: 12px; }
  body.dark .tabs { border-color: rgba(255,255,255,.08); }
  .tab { padding: 4px 10px; border-radius: 6px; background: rgba(0,0,0,.06); } body.dark .tab { background: rgba(255,255,255,.08); }
  iframe { flex: 1; border: 0; width: 100%; }
  .tools { position: fixed; left: 10px; top: 10px; display: flex; gap: 6px; } .tools button { font: inherit; }
  body.solo .chat, body.solo .tools, body.solo .tabs { display: none; } body.solo .panel { width: 100%; border: 0; }
</style></head><body><div class="tools"><button id="theme">切换明暗</button><button id="grow">加一张图</button></div>
<div class="chat">（对话区）</div><div class="panel"><div class="tabs"><span class="tab">上下文素材</span></div><iframe id="app"></iframe></div>
<script>
  const params = new URLSearchParams(location.search);
  let theme = params.get("theme") === "dark" ? "dark" : "light";
  if (params.get("width")) document.documentElement.style.setProperty("--w", params.get("width") + "px");
  document.body.classList.toggle("dark", theme === "dark");
  // ?solo=1 shows the side panel alone, for screenshots.
  document.body.classList.toggle("solo", params.has("solo"));
  const frame = document.getElementById("app");
  const send = (message) => frame.contentWindow.postMessage({ jsonrpc: "2.0", ...message }, "*");
  // ?thread=fresh: a thread that has no rollout, like a panel opened on a new chat whose prepared thread was replaced.
  // Each page load gets a thread of its own, so a switch made on an earlier load does not carry over.
  const fresh = params.get("thread") === "fresh" ? Math.random().toString(16).slice(2, 6).padEnd(4, "0") : null;
  const query = fresh ? "?fresh=" + fresh : params.get("thread") === "gap" ? "?gap=1" : params.get("thread") === "many" ? "?many=1" : "";
  const call = (name, args) => fetch("/call" + query, { method: "POST", body: JSON.stringify({ name, arguments: args }) }).then((r) => r.json());
  window.addEventListener("message", async (event) => {
    const m = event.data;
    if (!m || event.source !== frame.contentWindow) return;
    if (m.method === "ui/initialize") send({ id: m.id, result: { protocolVersion: "2026-01-26", hostInfo: { name: "panel-dev" }, hostCapabilities: { serverTools: {} }, hostContext: { theme, displayMode: "inline", locale: params.get("lang") === "en" ? "en-US" : "zh-CN" } } });
    else if (m.method === "ui/notifications/initialized") { send({ method: "ui/notifications/tool-result", params: await call("cam_panel", {}) }); demo(); }
    else if (m.method === "tools/call") { const delay = params.get("slow") ? 900 : 60; const result = await call(m.params.name, m.params.arguments); setTimeout(() => send({ id: m.id, result }), delay); }
  });
  // ?demo=pending|preview puts the panel in that state, for screenshots taken without clicking.
  function demo() {
    const d = frame.contentDocument;
    setTimeout(() => {
      if (params.get("demo") === "pending") d.querySelector('[data-id="IMG-002"] input')?.click();
      if (params.get("demo") === "preview") d.querySelector('[data-id="IMG-004"] .thumb')?.click();
      if (params.get("demo") === "disabled") d.querySelector("#plugin .off")?.click();
    }, 700);
    // The user sends the first message on this new chat (or two tasks start at once).
    if (params.get("newtask")) setTimeout(() => fetch("/newtask?count=" + params.get("newtask"), { method: "POST" }), 1500);
  }
  document.getElementById("theme").onclick = () => { theme = theme === "dark" ? "light" : "dark"; document.body.classList.toggle("dark", theme === "dark"); send({ method: "ui/notifications/host-context-changed", params: { theme } }); };
  document.getElementById("grow").onclick = () => fetch("/grow", { method: "POST" });
  // The engine statistics for this page load, then the panel.
  fetch("/stats?kind=" + (params.get("stats") || "normal"), { method: "POST" })
    .then(() => fetch("/setup?state=" + (params.get("setup") || "on"), { method: "POST" }))
    .then(() => { frame.src = "/panel.html"; });
</script></body></html>`;

let extra = 0;
createServer((request, response) => {
  const reply = (status: number, type: string, body: string) => { response.writeHead(status, { "content-type": type, "cache-control": "no-store" }); response.end(body); };
  if (request.method === "GET" && (request.url === "/" || request.url?.startsWith("/?"))) return reply(200, "text/html; charset=utf-8", HOST);
  if (request.method === "GET" && request.url === "/panel.html") return reply(200, "text/html; charset=utf-8", readFileSync(join(here, "..", "..", "plugin", "src", "panel.html"), "utf8"));
  if (request.method === "POST" && request.url?.startsWith("/stats")) {
    writeStats(new URL(request.url, "http://x").searchParams.get("kind") ?? "normal");
    return reply(200, "application/json", "{}");
  }
  if (request.method === "POST" && request.url?.startsWith("/setup")) {
    // Whether the (temporary) Codex home goes through the engine when the page loads.
    if (new URL(request.url, "http://x").searchParams.get("state") === "off") connectDirectly(); else useEngine(17891);
    // Each page load starts as a freshly started Codex: nothing waits for a restart.
    resetSetupBaseline();
    return reply(200, "application/json", "{}");
  }
  if (request.method === "POST" && request.url?.startsWith("/newtask")) {
    startTasks(Number(new URL(request.url, "http://x").searchParams.get("count")) || 1);
    return reply(200, "application/json", "{}");
  }
  if (request.method === "POST" && request.url === "/grow") {
    // A new turn with one more upload, to watch the panel pick it up by polling.
    extra++;
    const file = join(day, `rollout-2026-09-24T10-00-00-${THREAD}.jsonl`);
    writeFileSync(file, readFileSync(file, "utf8") + turn(`x${extra}`) + upload(`msg_x${extra}`, `x${extra}`, [[`new-${extra}.png`, png(300, 200, (x, y) => [(x * extra * 40) % 256, (y * 3) % 256, 150])]]));
    return reply(200, "application/json", "{}");
  }
  if (request.method === "POST" && request.url?.startsWith("/call")) {
    const fresh = new URL(request.url, "http://x").searchParams.get("fresh");
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      const { name, arguments: args } = JSON.parse(body);
      const freshId = `${THREAD.slice(0, -4)}${fresh}`;
      const gap = new URL(request.url, "http://x").searchParams.has("gap");
      const many = new URL(request.url, "http://x").searchParams.has("many");
      const threadMeta = fresh && /^[0-9a-f]{4}$/.test(fresh) ? { threadId: freshId, thread_id: freshId } : gap ? { threadId: GAP, thread_id: GAP } : many ? manyMeta : meta;
      try { reply(200, "application/json", JSON.stringify(callTool(name, args ?? {}, threadMeta, sessionsDir))); }
      catch (error) { reply(200, "application/json", JSON.stringify({ isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }] })); }
    });
    return;
  }
  reply(404, "text/plain", "not found");
}).listen(port, "127.0.0.1", () => console.log(`panel dev page: http://127.0.0.1:${port}/  (data in ${root})`));
