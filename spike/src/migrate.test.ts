// Purpose: check the migration rules from docs/spec.md on synthetic turns (no real session data).
// Input: synthetic UI-level turns; output: Node test assertions only.

import assert from "node:assert/strict";
import test from "node:test";
import { buildMigration, redactPaths, type AssetInfo } from "./migrate.ts";

const assets: Record<string, AssetInfo> = {
  "C:\\work\\shots\\bridge.png": { assetId: "IMG-001", name: "bridge.png", width: 1672, height: 941, bytes: 2_336_942 },
  "C:\\work\\shots\\lake.png": { assetId: "IMG-002", name: "lake.png", width: 1672, height: 941, bytes: 2_869_595 },
};
const resolve = (path: string) => assets[path] ?? null;

const turns = [
  {
    status: "completed",
    items: [
      { type: "userMessage", content: [{ type: "text", text: "参考这张桥的照片" }, { type: "localImage", path: "C:\\work\\shots\\bridge.png" }] },
      { type: "reasoning", summary: ["secret chain of thought"] },
      { type: "commandExecution", command: "rg -n title 'C:\\work\\shots\\notes.md'", exitCode: 0 },
      { type: "agentMessage", text: "好的，我看过了。" },
    ],
  },
  {
    status: "failed",
    items: [
      { type: "userMessage", content: [{ type: "text", text: "再看看湖" }, { type: "localImage", path: "C:\\work\\shots\\lake.png" }] },
      { type: "imageView", path: "C:\\work\\shots\\bridge.png" },
    ],
  },
];

const texts = (items: Array<Record<string, any>>) => items.map((item) => item.content[0].text as string);

test("omitted, repeated and attached images follow the placeholder rules", () => {
  const migration = buildMigration(turns, resolve, { sourceName: "测试任务", attachments: new Map([["IMG-002", 1]]) });
  const all = texts(migration.items);
  const bridge = all.find((text) => text.includes("[素材 IMG-001"))!;
  assert.match(bridge, /bridge\.png/);
  assert.match(bridge, /不能据此判断画面细节/);
  assert.match(bridge, /需要 IMG-001/);
  const lake = all.find((text) => text.includes("[素材 IMG-002"))!;
  assert.match(lake, /作为附件 1 提供/);
  assert.ok(all.some((text) => text.includes("与 IMG-001 为同一素材")), "repeat view is a short reference");
  assert.equal(migration.imageOccurrences, 3);
  assert.equal(migration.unresolvedImages, 0);
});

test("history keeps text, drops reasoning, records tools and failed turns", () => {
  const migration = buildMigration(turns, resolve, { sourceName: "测试任务", attachments: new Map() });
  const [index, ...history] = migration.items;
  assert.equal(index.role, "developer");
  assert.match(index.content[0].text, /IMG-001｜bridge\.png/);
  assert.deepEqual(history.map((item) => item.role), ["user", "assistant", "assistant", "user", "assistant", "assistant"]);
  const all = texts(migration.items).join("\n");
  assert.doesNotMatch(all, /secret chain of thought/);
  assert.match(all, /执行命令（退出码 0）：rg -n title 'notes\.md'/);
  assert.match(all, /\[此轮未完成：失败\]/);
  assert.doesNotMatch(all, /C:\\work/, "no absolute path reaches the model");
});

test("redactPaths keeps only file names, including quoted paths with spaces", () => {
  assert.equal(redactPaths("rg -n x 'C:\\my docs\\a b\\c.md'"), "rg -n x 'c.md'");
  assert.equal(redactPaths('view "C:\\my docs\\shot 1.png" now'), 'view "shot 1.png" now');
  assert.equal(redactPaths("type C:\\work\\x.txt"), "type x.txt");
  assert.equal(redactPaths("cat /home/me/notes/x.md"), "cat x.md");
});

test("file changes under folders with spaces record only the file name", () => {
  const migration = buildMigration(
    [{ status: "completed", items: [{ type: "userMessage", content: [{ type: "text", text: "改一下" }] }, { type: "fileChange", changes: [{ path: "C:\\my docs\\Go To\\spec.md" }] }] }],
    resolve,
    { sourceName: "测试任务", attachments: new Map() },
  );
  const all = texts(migration.items).join("\n");
  assert.match(all, /修改文件：spec\.md/);
  assert.doesNotMatch(all, /my docs|Go To/);
});
