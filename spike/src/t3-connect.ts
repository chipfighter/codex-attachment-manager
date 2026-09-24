// Purpose: T3 — start an independent app-server with the desktop-bundled codex.exe and make read-only calls.
// Input: --threads <id,id>; output: local/t3-connect.json (thread metadata only, no conversation content).

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AppServer, findBundledCodex } from "./appserver.ts";

const localRoot = join(resolve(dirname(fileURLToPath(import.meta.url)), "../.."), "local");

function argument(name: string): string {
  const index = process.argv.indexOf(name);
  const value = process.argv[index + 1];
  if (index < 0 || !value) throw new Error(`missing ${name}`);
  return value;
}

function summary(thread: Record<string, any>): Record<string, unknown> {
  const { id, name, forkedFromId, historyMode, modelProvider, model, reasoningEffort, status, cliVersion, source, originator, createdAt, updatedAt, ephemeral, cwd } = thread;
  return { id, name, preview: String(thread.preview ?? "").slice(0, 40), forkedFromId, historyMode, modelProvider, model, reasoningEffort, status, cliVersion, source, originator, createdAt, updatedAt, ephemeral, cwd };
}

async function main(): Promise<void> {
  const threadIds = argument("--threads").split(",").filter(Boolean);
  const codex = findBundledCodex();
  const codexVersion = execFileSync(codex, ["--version"]).toString().trim();
  mkdirSync(join(localRoot, "logs"), { recursive: true });
  const stamp = new Date().toISOString().replaceAll(":", "-");
  const server = new AppServer(codex, [], {}, join(localRoot, "logs", `t3-appserver-${stamp}.log`));
  try {
    const init = await server.initialize();
    const threads = [];
    for (const threadId of threadIds) {
      const response = await server.request<{ thread: Record<string, any> }>("thread/read", { threadId, includeTurns: false });
      threads.push(summary(response.thread));
    }
    const listedIds: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page: { data: Array<{ id: string }>; nextCursor: string | null } = await server.request("thread/list", { cursor, limit: 100 });
      listedIds.push(...page.data.map((thread) => thread.id));
      cursor = page.nextCursor;
      pages++;
    } while (cursor && pages < 20 && !threadIds.every((id) => listedIds.includes(id)));
    const result = {
      createdAt: new Date().toISOString(),
      codexVersion,
      platformFamily: init.platformFamily,
      threads,
      listed: Object.fromEntries(threadIds.map((id) => [id, listedIds.includes(id)])),
      listPagesScanned: pages,
      notificationsSeen: [...new Set(server.notifications.map((n) => n.method))],
    };
    writeFileSync(join(localRoot, "t3-connect.json"), JSON.stringify(result, null, 2));
    console.log(JSON.stringify({ ...result, threads: threads.map(({ cwd, ...rest }) => rest) }, null, 2));
  } finally {
    console.log(`app-server exit code: ${await server.stop()}`);
  }
}

await main();
