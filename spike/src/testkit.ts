// Purpose: shared helpers for the P2 self-tests — synthetic PNG test images (no user material is ever sent) and a
// turn runner for our own app-server.
// Input: drawing callbacks / app-server handles. Output: PNG bytes, turn summaries.

import zlib from "node:zlib";
import type { AppServer } from "./appserver.ts";

type Json = Record<string, any>;
type Rgb = [number, number, number];

export function png(width: number, height: number, pixel: (x: number, y: number) => Rgb): Buffer {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (width * 3 + 1);
    for (let x = 0; x < width; x++) raw.set(pixel(x, y), row + 1 + x * 3);
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

// Each image has one large shape and one small corner mark, so a test can ask about a detail
// that a one-line description would not mention.
const SIZE = 512;
const inBox = (x: number, y: number, left: number, top: number, size: number) => x >= left && x < left + size && y >= top && y < top + size;

export const testImages = {
  // White background, red square in the middle, small black square in the bottom-right corner.
  redSquare: () => png(SIZE, SIZE, (x, y) => inBox(x, y, 440, 440, 48) ? [0, 0, 0] : inBox(x, y, 136, 136, 240) ? [220, 30, 30] : [255, 255, 255]),
  // Yellow background, blue disc in the middle, small green square in the top-left corner.
  blueCircle: () => png(SIZE, SIZE, (x, y) => inBox(x, y, 24, 24, 48) ? [30, 160, 60] : (x - 256) ** 2 + (y - 256) ** 2 < 130 ** 2 ? [40, 70, 210] : [250, 220, 60]),
  // Purple background, white upward triangle, small orange square in the top-right corner.
  whiteTriangle: () => png(SIZE, SIZE, (x, y) => inBox(x, y, 440, 24, 48) ? [250, 140, 20] : y > 120 && y < 400 && Math.abs(x - 256) < (y - 120) * 0.6 ? [255, 255, 255] : [120, 50, 160]),
  // 1024×1024 of reproducible noise (about 3 MB): shows what unchecking a large image saves, since it cannot compress.
  noise: () => {
    let state = 0x2545f491;
    const next = () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return state & 0xff; };
    return png(1024, 1024, () => [next(), next(), next()]);
  },
};

// Tests use gpt-6-sol at low effort to save the user's tokens (AGENTS.md). v0.1-24: CAM_TEST_MODEL and CAM_TEST_EFFORT
// run the same test on another model, to check that the text for the model works for every GPT-6 model.
export const TEST_MODEL = process.env.CAM_TEST_MODEL?.trim() || "gpt-6-sol";
export const TEST_EFFORT = process.env.CAM_TEST_EFFORT?.trim() || "low";

export const text = (value: string) => ({ type: "text", text: value, text_elements: [] });

export async function runTurn(server: AppServer, threadId: string, input: Json[], timeoutMs = 20 * 60_000): Promise<Json> {
  const started = Date.now();
  const before = server.notifications.length;
  const { turn } = await server.request<{ turn: Json }>("turn/start", { threadId, input, effort: TEST_EFFORT }, 120_000);
  const done = await server.waitFor((n) => n.method === "turn/completed" && n.params.turn?.id === turn.id, timeoutMs);
  const mine = server.notifications.slice(before).filter((n) => n.params?.turnId === turn.id || n.params?.turn?.id === turn.id);
  const items = mine.filter((n) => n.method === "item/completed").map((n) => n.params.item);
  return {
    turnId: turn.id,
    status: done.params.turn.status,
    error: done.params.turn.error ?? null,
    ms: Date.now() - started,
    tools: items.filter((item) => !["agentMessage", "reasoning", "userMessage"].includes(item.type)).map((item) => `${item.type}:${item.status ?? ""}`),
    reply: items.filter((item) => item.type === "agentMessage").map((item) => item.text).join(" "),
    errors: mine.filter((n) => n.method === "error").map((n) => ({ message: n.params.error?.message ?? "error", willRetry: n.params.willRetry ?? null })),
  };
}
