// Purpose: P2 — command-line stand-in for the panel: list a thread's images and check/uncheck them.
// Input: list <thread> | uncheck <thread> IMG-… | check <thread> IMG-… | check-all <thread>.
// Output: the selection file under local/selection/ and a table on stdout. Rollouts are only read.

import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { codexHome } from "./codexconfig.ts";
import { readSelection, writeSelection } from "./selection.ts";
import { loadThreadIndex, type IndexedImage, type ThreadIndex } from "./thread-index.ts";

export function sameContent(index: ThreadIndex, image: IndexedImage): string[] {
  return index.images
    .filter((other) => other !== image && (other.contentId === image.contentId || (image.pixelSha256 !== null && other.pixelSha256 === image.pixelSha256)))
    .map((other) => other.id);
}

function table(index: ThreadIndex): string {
  const unchecked = new Set(Object.keys(readSelection(index.threadId).unchecked));
  const rows = index.images.map((image) => [
    image.id,
    !image.replaceable ? "锁定" : unchecked.has(image.key) ? "取消" : "勾选",
    image.kind,
    image.name ?? "—",
    image.turn ?? "—",
    image.width && image.height ? `${image.width}×${image.height}` : "—",
    `${(image.bytes / 1024).toFixed(0)} KB`,
    sameContent(index, image).join(",") || "—",
  ].join(" | "));
  return [`thread ${index.threadId}: ${index.images.length} images, ${index.turns} turns`, "id | 状态 | 种类 | 名称 | 轮次 | 尺寸 | 大小 | 内容相同", ...rows].join("\n");
}

function main(): void {
  const [command, threadId, ...ids] = process.argv.slice(2);
  if (!command || !threadId) throw new Error("usage: cam.ts list|uncheck|check|check-all <thread id> [IMG-…]");
  const index = loadThreadIndex(join(codexHome(), "sessions"), threadId);
  if (command !== "list") {
    const selection = readSelection(threadId);
    const unchecked = { ...selection.unchecked };
    if (command === "check-all") for (const key of Object.keys(unchecked)) delete unchecked[key];
    for (const id of ids) {
      const image = index.images.find((candidate) => candidate.id === id);
      if (!image) throw new Error(`${id} is not an image of this thread`);
      if (command === "uncheck") {
        if (!image.replaceable) throw new Error(`${id} cannot be unchecked yet (hosted image generation result)`);
        unchecked[image.key] = { id, at: new Date().toISOString() };
      } else if (command === "check") delete unchecked[image.key];
      else throw new Error(`unknown command ${command}`);
    }
    writeSelection({ threadId, unchecked });
  }
  console.log(table(index));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
