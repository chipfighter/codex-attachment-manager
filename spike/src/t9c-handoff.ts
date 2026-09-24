// Purpose: T9c — build a route B handoff package: the migrated conversation as Markdown plus copies of the selected images,
// for a user who starts a new Codex task by hand.
// Input: local/rebuild-preview.json (from `rebuild.ts preview`) and local/matches.json. Output: local/handoff/<stamp>/.

import { copyFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const localRoot = join(resolve(dirname(fileURLToPath(import.meta.url)), "../.."), "local");

function main(): void {
  const preview = JSON.parse(readFileSync(join(localRoot, "rebuild-preview.json"), "utf8"));
  const stamp = new Date().toISOString().replaceAll(":", "-").slice(0, 19);
  const out = join(localRoot, "handoff", stamp);
  mkdirSync(out, { recursive: true });
  const files = preview.selected.map((selected: { assetId: string; attachmentPath: string }) => {
    const name = `${selected.assetId}${extname(selected.attachmentPath)}`;
    copyFileSync(selected.attachmentPath, join(out, name));
    return name;
  });
  const roleLabel: Record<string, string> = { developer: "说明", user: "用户", assistant: "助手" };
  const markdown = [
    `# 交接包：${preview.sourceName}`,
    "",
    "使用方法：在 Codex 里新建任务，把本文件和下列图片一起附上，然后告诉 Codex“先读交接说明，再继续原任务”。",
    "",
    `随附图片：${files.map((file: string) => `\`${file}\``).join("、")}（附件编号按这个顺序：${files.map((file: string, i: number) => `附件 ${i + 1} = ${file.replace(extname(file), "")}`).join("，")}）`,
    "",
    ...preview.items.map((item: { role: string; content: Array<{ text: string }> }) => `## ${roleLabel[item.role] ?? item.role}\n\n${item.content[0].text}\n`),
  ].join("\n");
  writeFileSync(join(out, "交接说明.md"), markdown);
  const bytes = statSync(join(out, "交接说明.md")).size;
  console.log(JSON.stringify({ folder: `local/handoff/${stamp}`, files: ["交接说明.md", ...files], markdownBytes: bytes }, null, 2));
}

main();
