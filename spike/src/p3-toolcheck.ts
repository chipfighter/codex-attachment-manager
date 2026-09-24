// Purpose: P3-1 — see whether and how the panel's MCP tool reaches the model: run one turn ("打开素材面板") through our
// own app-server, which loads the same config.toml (including the managed probe server). The proxy must run with
// --force-http --dump-requests, so the request (tool list included) is saved under local/p2/requests/.
// Input: [--port 17891]. Output: console summary of the turn (tool calls and reply).

import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AppServer, findBundledCodex } from "./appserver.ts";
import { runTurn, TEST_MODEL, text } from "./testkit.ts";

type Json = Record<string, any>;
const localRoot = join(resolve(dirname(fileURLToPath(import.meta.url)), "../.."), "local");

async function main(): Promise<void> {
  const port = Number(process.argv.includes("--port") ? process.argv[process.argv.indexOf("--port") + 1] : 17891);
  const workDir = join(localRoot, "p3", "work");
  mkdirSync(workDir, { recursive: true });
  const startedAt = new Date().toISOString();
  const server = new AppServer(findBundledCodex(), ["-c", `openai_base_url="http://localhost:${port}/backend-api/codex"`, "-c", "features.respect_system_proxy=true"], {}, join(localRoot, "logs", `p3-toolcheck-${startedAt.replaceAll(":", "-")}.log`));
  try {
    await server.initialize();
    const { thread } = await server.request<{ thread: Json }>("thread/start", { model: TEST_MODEL, cwd: workDir, approvalPolicy: "never", sandbox: "read-only", ephemeral: true });
    const turn = await runTurn(server, thread.id, [text("打开素材面板")]);
    const items = server.notifications.filter((n) => n.method === "item/completed" && n.params.turnId === turn.turnId).map((n) => n.params.item);
    console.log(JSON.stringify({ startedAt, threadId: thread.id, status: turn.status, reply: turn.reply, tools: items.filter((i) => !["agentMessage", "reasoning", "userMessage"].includes(i.type)).map((i) => ({ type: i.type, server: i.server ?? null, tool: i.tool ?? null, status: i.status ?? null, mcpAppUi: i.mcpAppUi ?? null })) }, null, 2));
  } finally {
    await server.stop();
  }
}

await main();
