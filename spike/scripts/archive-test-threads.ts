// Purpose: archive the tasks the self-tests left in the user's Codex — tasks named "[CAM测试] …" or "[CAM test] …" that
// are not archived yet, e.g. from runs before the self-tests archived their own tasks (user 2026-09-28). No other task
// is touched; archived tasks stay readable under Codex's archived tasks. Codex may show them until it restarts.
// Input: `node spike/scripts/archive-test-threads.ts [--dry-run]`; CODEX_HOME. Output: the names of the tasks archived.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { codexHome } from "../../plugin/src/codexconfig.ts";
import { AppServer, findBundledCodex } from "../src/appserver.ts";
import { archiveThreads } from "../src/testkit.ts";

// Only the names the test scripts give their tasks; a task that merely starts with "[CAM测试]" is left alone.
const TEST_NAME = /^\[CAM测试\] (P\d|v0\.1 占位符自测 |截图编号自测 )|^\[CAM test\] (v0\.1 placeholder self-test |screenshot id self-test )/;
const dryRun = process.argv.includes("--dry-run");
const home = codexHome();
const indexFile = join(home, "session_index.jsonl");
if (!existsSync(indexFile)) throw new Error(`no ${indexFile}`);

// A task's name is the last one written for it.
const names = new Map<string, string>();
for (const line of readFileSync(indexFile, "utf8").split(/\r?\n/)) {
  try { const entry = JSON.parse(line); if (entry?.id) names.set(entry.id, String(entry.thread_name ?? "")); } catch { /* skip */ }
}
// Not archived yet: the rollout is still under sessions/ (archiving moves it to archived_sessions/, which the thread
// index also reads, so its lookups cannot tell the two apart).
const live = new Set<string>();
const walk = (dir: string): void => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) walk(join(dir, entry.name));
    else { const id = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/.exec(entry.name)?.[1]; if (id) live.add(id); }
  }
};
if (existsSync(join(home, "sessions"))) walk(join(home, "sessions"));
const targets = [...names].filter(([id, name]) => TEST_NAME.test(name) && live.has(id));
for (const [, name] of targets) console.log(name);
console.log(`${targets.length} test task(s) ${dryRun ? "would be archived" : "to archive"}`);

if (!dryRun && targets.length) {
  const server = new AppServer(findBundledCodex(), ["-c", "notify=[]"], {}, join(process.env.TEMP ?? home, "cam-archive-appserver.log"));
  try {
    await server.initialize();
    const failed = await archiveThreads(server, targets.map(([id]) => id));
    console.log(`archived ${targets.length - failed.length}${failed.length ? `, failed ${failed.length}: ${failed.join(", ")}` : ""}`);
  } finally {
    await server.stop();
  }
}
