// Purpose: regression test for view_image path attribution when parallel calls finish out of order.
// Input: temporary synthetic files; output: Node test assertions only.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathForViewedImage } from "./viewpaths.ts";

const sha256 = (data: string) => createHash("sha256").update(data).digest("hex");

test("each output image gets the path whose bytes match, whatever the event order", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cam-viewpaths-"));
  try {
    const bridge = join(dir, "bridge.png");
    const timelapse = join(dir, "timelapse.png");
    writeFileSync(bridge, "bridge-bytes");
    writeFileSync(timelapse, "timelapse-bytes");
    // Events arrived as [bridge, timelapse] while the tool output listed timelapse first.
    const candidates = [bridge, timelapse];
    const cache = new Map<string, string | null>();
    assert.equal(await pathForViewedImage(candidates, sha256("timelapse-bytes"), cache), timelapse);
    assert.equal(await pathForViewedImage(candidates, sha256("bridge-bytes"), cache), bridge);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an image whose bytes match no candidate gets no path", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cam-viewpaths-"));
  try {
    const only = join(dir, "only.png");
    writeFileSync(only, "only-bytes");
    assert.equal(await pathForViewedImage([only, join(dir, "missing.png")], sha256("resized-bytes"), new Map()), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
