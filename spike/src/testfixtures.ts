// Purpose: synthetic rollouts for unit tests — a temporary sessions folder with one thread whose history holds
// uploads, a viewed image and assistant replies. No real session data.
// Input: record builders. Output: file paths and ids to use in assertions.

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { png } from "./testkit.ts";

export const THREAD = "01a0d301-0000-7000-8000-00000000abcd";
export const red = png(64, 32, (x, y) => [230, (x * 7) % 256, (y * 5) % 256]);
export const blue = png(8, 8, () => [0, 0, 255]);
const url = (bytes: Buffer) => `data:image/png;base64,${bytes.toString("base64")}`;

export const line = (type: string, payload: Record<string, any>) => `${JSON.stringify({ timestamp: "2026-09-24T10:00:00Z", type, payload })}\n`;
export const turn = (id: string) => line("event_msg", { type: "task_started", turn_id: id });
export const assistant = (text: string, turnId: string) => line("response_item", { type: "message", role: "assistant", content: [{ type: "output_text", text }], internal_chat_message_metadata_passthrough: { turn_id: turnId } });
export const upload = (id: string, turnId: string, images: Array<[string, Buffer]>) => line("response_item", {
  type: "message", id, role: "user",
  content: images.flatMap(([name, bytes], i) => [
    { type: "input_text", text: `<image name=[Image #${i + 1}] path="C:\\w\\${name}">` },
    { type: "input_image", image_url: url(bytes) },
    { type: "input_text", text: "</image>" },
  ]),
  internal_chat_message_metadata_passthrough: { turn_id: turnId },
});

// Turn 1 uploads a.png (red), b.png and b-copy.png (both blue); turn 2 is the model asking for IMG-001.
export function sampleSessions(extra = ""): { sessionsDir: string; dataRoot: string } {
  const root = mkdtempSync(join(tmpdir(), "cam-fixture-"));
  const day = join(root, "sessions", "2026", "09", "24");
  mkdirSync(day, { recursive: true });
  writeFileSync(join(day, `rollout-2026-09-24T10-00-00-${THREAD}.jsonl`),
    line("session_meta", { id: THREAD }) +
    turn("t1") + upload("msg_1", "t1", [["a.png", red], ["b.png", blue], ["b-copy.png", blue]]) + assistant("收到", "t1") +
    turn("t2") + assistant("需要 IMG-001。IMG-003 与 IMG-002 相同。", "t2") + extra);
  return { sessionsDir: join(root, "sessions"), dataRoot: join(root, "data") };
}

// The folder Codex files a rollout started now in (sessions/YYYY/MM/DD, local time): where new threads appear.
export function todayFolder(sessionsDir: string): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const folder = join(sessionsDir, String(now.getFullYear()), pad(now.getMonth() + 1), pad(now.getDate()));
  mkdirSync(folder, { recursive: true });
  return folder;
}

// A thread whose first message was sent `agoMs` ago: Codex writes the rollout's first line at that moment.
export function startThread(sessionsDir: string, id: string, meta: Record<string, any> = {}, agoMs = 0, body = ""): string {
  const at = new Date(Date.now() - agoMs).toISOString();
  const file = join(todayFolder(sessionsDir), `rollout-${at.slice(0, 19).replace(/:/g, "-")}-${id}.jsonl`);
  writeFileSync(file, `${JSON.stringify({ timestamp: at, type: "session_meta", payload: { id, timestamp: at, source: "vscode", thread_source: "user", ...meta } })}\n${body}`);
  return file;
}
