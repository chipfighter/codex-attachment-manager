// Purpose: P3-4 — installing writes every managed block (and .env only when needed); uninstalling restores both
// files byte for byte; a conflict leaves everything untouched.
// Input: synthetic config and .env texts; output: Node test assertions only.

import assert from "node:assert/strict";
import test from "node:test";
import { needsNoProxy, planInstall, planUninstall, SERVER_NAME } from "./install.ts";

const CONFIG = 'model = "gpt-6-sol"\n\n[features]\nview_image = true\n\n[projects.\'d:\\\\work\']\ntrust_level = "trusted"\n';
const base = { port: 17891, nodePath: "C:\\Program Files\\nodejs\\node.exe", serverScript: "D:\\cam\\plugin-server.ts" };
const proxied = { httpProxy: "http://127.0.0.1:8888", noProxy: null };
const direct = { httpProxy: null, noProxy: null };

test(".env is needed only when an environment proxy would swallow loopback requests", () => {
  assert.equal(needsNoProxy(proxied), true);
  assert.equal(needsNoProxy(direct), false);
  assert.equal(needsNoProxy({ httpProxy: "http://p:1", noProxy: "localhost,127.0.0.1,::1" }), false);
  assert.equal(needsNoProxy({ httpProxy: "http://p:1", noProxy: "*" }), false);
});

test("install writes the proxy settings, the MCP server and, with an environment proxy, .env", () => {
  const plan = planInstall({ ...base, configText: CONFIG, envText: null, env: proxied });
  assert.equal(plan.configChanged, true);
  assert.match(plan.configText, /^# >>> codex-attachment-manager: managed proxy setting/);
  assert.match(plan.configText, /openai_base_url = "http:\/\/localhost:17891\/backend-api\/codex"/);
  assert.match(plan.configText, /respect_system_proxy = true/);
  assert.match(plan.configText, new RegExp(`\\[mcp_servers\\.${SERVER_NAME}\\]`));
  assert.equal(plan.envChanged, true);
  assert.match(plan.envText!, /NO_PROXY=localhost,127\.0\.0\.1,::1/);
  const again = planInstall({ ...base, configText: plan.configText, envText: plan.envText, env: proxied });
  assert.deepEqual([again.configChanged, again.envChanged], [false, false], "installing twice changes nothing");
});

test("without an environment proxy no .env is written, and an old block is cleared", () => {
  const plan = planInstall({ ...base, configText: CONFIG, envText: null, env: direct });
  assert.deepEqual([plan.envText, plan.envChanged], [null, false]);
  const withOld = planInstall({ ...base, configText: CONFIG, envText: planInstall({ ...base, configText: CONFIG, envText: "KEEP=1\n", env: proxied }).envText, env: direct });
  assert.deepEqual([withOld.envText, withOld.envChanged], ["KEEP=1\n", true]);
});

test("uninstall restores config.toml and .env byte for byte, deleting a .env that only held our block", () => {
  for (const envText of [null, "OPENAI_API_KEY=not-a-real-key\n"]) {
    const installed = planInstall({ ...base, configText: CONFIG, envText, env: proxied });
    const removed = planUninstall({ configText: installed.configText, envText: installed.envText });
    assert.equal(removed.configText, CONFIG);
    assert.equal(removed.envText, envText);
  }
});

test("a conflict stops the whole install before anything is written", () => {
  const mine = 'openai_base_url = "https://example.test/v1"\n' + CONFIG;
  assert.throws(() => planInstall({ ...base, configText: mine, envText: null, env: proxied }), /already sets openai_base_url/);
  assert.throws(() => planInstall({ ...base, configText: CONFIG, envText: "NO_PROXY=corp\n", env: proxied }), /already sets NO_PROXY/);
});
