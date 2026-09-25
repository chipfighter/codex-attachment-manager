// Purpose: verify pixel identity across differently encoded PNG files.
// Input: synthetic 1×1 PNG buffers; output: Node test assertions only.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { deflateSync } from "node:zlib";
import { decodePng } from "../../plugin/src/png.ts";

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  return Buffer.concat([length, Buffer.from(type), data, Buffer.alloc(4)]);
}

function onePixelPng(colorType: 2 | 6, color: number[], compressionLevel: number): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0);
  header.writeUInt32BE(1, 4);
  header[8] = 8;
  header[9] = colorType;
  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.from([0, ...color]), { level: compressionLevel })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

test("RGB and RGBA encodings of the same picture share a pixel hash", () => {
  const rgb = onePixelPng(2, [255, 0, 0], 1);
  const rgba = onePixelPng(6, [255, 0, 0, 255], 9);
  const expectedPixels = Buffer.alloc(8 + 4);
  expectedPixels.writeUInt32BE(1, 0);
  expectedPixels.writeUInt32BE(1, 4);
  Buffer.from([255, 0, 0, 255]).copy(expectedPixels, 8);
  const expectedHash = createHash("sha256").update(expectedPixels).digest("hex");

  assert.notDeepEqual(rgb, rgba);
  assert.equal(decodePng(rgb).pixelSha256, expectedHash);
  assert.equal(decodePng(rgba).pixelSha256, expectedHash);
});
