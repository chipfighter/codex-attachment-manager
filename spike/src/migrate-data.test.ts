// Purpose: v0.1-15 — Windows moves the tool's data out of AppData: the old folder and every Store app's private copy
// are merged into the new folder once, the newest copy of each file winning; logs stay behind; several processes
// starting at once copy only once, and a lock left by a crashed one is taken over.
// Input: synthetic folders in a temporary LOCALAPPDATA; output: Node test assertions only.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { migrateWindowsData, oldWindowsFolders } from "../../plugin/src/migrate-data.ts";

const NAME = "codex-attachment-manager";

function put(file: string, text: string, minutesAgo: number): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
  const at = new Date(Date.now() - minutesAgo * 60_000);
  utimesSync(file, at, at);
}

function layout() {
  const local = mkdtempSync(join(tmpdir(), "cam-localappdata-"));
  const old = join(local, NAME);
  const codex = join(local, "Packages", "OpenAI.Codex_x", "LocalCache", "Local", NAME);
  const claude = join(local, "Packages", "Claude_y", "LocalCache", "Local", NAME);
  mkdirSync(join(local, "Packages", "Other_z", "LocalCache", "Local"), { recursive: true });
  put(join(old, "selection", "A.json"), "old A", 30);
  put(join(old, "state", "requests", "R.json"), "R", 20);
  put(join(old, "language.json"), "old language", 40);
  put(join(old, "plugin-server.jsonl"), "a log", 1);
  put(join(codex, "selection", "A.json"), "codex A", 10);
  put(join(codex, "selection", "B.json"), "B", 12);
  put(join(codex, "bindings", "X.json"), "X", 15);
  put(join(codex, "language.json"), "codex language", 5);
  put(join(codex, "cache", "pixels", "ab", "ab01"), "fingerprint", 5);
  put(join(claude, "selection", "C.json"), "C", 8);
  put(join(claude, "config-backup", "config.toml.2026-09-25T10-00-00.000Z"), "backup", 60);
  return { local, old, codex, claude, target: join(mkdtempSync(join(tmpdir(), "cam-profile-")), `.${NAME}`) };
}

test("the old folder and every Store app's private copy are merged once, the newest copy of each file winning", () => {
  const { local, old, codex, claude, target } = layout();
  assert.deepEqual(oldWindowsFolders(local).sort(), [old, claude, codex].sort(), "only folders that exist");
  const result = migrateWindowsData(target, local);
  assert.equal(result?.copied, 7);
  const read = (file: string) => readFileSync(join(target, file), "utf8");
  assert.deepEqual([read("selection/A.json"), read("selection/B.json"), read("selection/C.json"), read("bindings/X.json"), read("state/requests/R.json"), read("language.json")],
    ["codex A", "B", "C", "X", "R", "codex language"]);
  assert.equal(read("config-backup/config.toml.2026-09-25T10-00-00.000Z"), "backup");
  assert.equal(existsSync(join(target, "plugin-server.jsonl")), false, "logs stay behind");
  assert.equal(existsSync(join(target, "cache")), false, "caches are rebuilt");
  assert.ok(Math.abs(statSync(join(target, "selection", "A.json")).mtimeMs - statSync(join(codex, "selection", "A.json")).mtimeMs) < 2000, "the copy keeps its time");
  assert.ok(existsSync(join(target, "migrated.json")));
  assert.equal(migrateWindowsData(target, local), null, "once only");
  assert.equal(readFileSync(join(old, "selection", "A.json"), "utf8"), "old A", "the old folders are left as they are");
});

test("while another process copies, the others wait for it; a lock left by a crashed one is taken over", () => {
  const busy = layout();
  mkdirSync(busy.target, { recursive: true });
  writeFileSync(join(busy.target, ".migrating"), "1234");
  assert.equal(migrateWindowsData(busy.target, busy.local, 200), null, "a fresh lock: someone else is copying");
  assert.equal(existsSync(join(busy.target, "migrated.json")), false);
  const stale = layout();
  mkdirSync(stale.target, { recursive: true });
  put(join(stale.target, ".migrating"), "1234", 2);
  assert.equal(migrateWindowsData(stale.target, stale.local, 200)?.copied, 7);
  assert.equal(existsSync(join(stale.target, ".migrating")), false);
});

test("without old folders there is nothing to copy, and the new folder is marked anyway", () => {
  const target = join(mkdtempSync(join(tmpdir(), "cam-profile-")), `.${NAME}`);
  const empty = mkdtempSync(join(tmpdir(), "cam-localappdata-"));
  assert.deepEqual(oldWindowsFolders(""), []);
  assert.deepEqual(migrateWindowsData(target, empty), { copied: 0, sources: [] });
  assert.equal(migrateWindowsData(target, empty), null);
});
