// Purpose: P1-1 — the managed config.toml block is inserted and removed without touching anything else.
// Input: synthetic config texts; output: Node test assertions only.

import assert from "node:assert/strict";
import test from "node:test";
import { disableProxy, enableProxy, proxyStatus } from "./codexconfig.ts";

const URL = "http://127.0.0.1:17891/backend-api/codex";
const original = 'model = "gpt-6-sol"\n\n[features]\nview_image = true\n\n[mcp_servers.demo]\ncommand = "node"\n';

function topLevelKeys(text: string): string[] {
  const keys: string[] = [];
  for (const line of text.replace(/^﻿/, "").split(/\r?\n/)) {
    if (/^\s*\[/.test(line)) break;
    const key = /^\s*([A-Za-z0-9_.-]+)\s*=/.exec(line)?.[1];
    if (key) keys.push(key);
  }
  return keys;
}

test("enable puts openai_base_url at top level, before every table", () => {
  const { text, changed } = enableProxy(original, URL);
  assert.equal(changed, true);
  assert.deepEqual(topLevelKeys(text), ["openai_base_url", "model"]);
  assert.match(text, new RegExp(`openai_base_url = "${URL.replaceAll("/", "\\/")}"`));
  assert.ok(text.endsWith(original), "everything after the block is unchanged");
});

test("enable then disable restores the file byte for byte", () => {
  for (const sample of [original, "", "﻿" + original.replaceAll("\n", "\r\n"), "# only a comment\n"]) {
    assert.equal(disableProxy(enableProxy(sample, URL).text).text, sample);
  }
});

test("CRLF files get a CRLF block and keep their BOM", () => {
  const crlf = "﻿" + original.replaceAll("\n", "\r\n");
  const { text } = enableProxy(crlf, URL);
  assert.ok(text.startsWith("﻿# >>>"));
  assert.doesNotMatch(text.replaceAll("\r\n", ""), /\n/, "no bare LF introduced");
});

test("enabling twice is a no-op, and a new URL only replaces the managed line", () => {
  const once = enableProxy(original, URL).text;
  assert.deepEqual(enableProxy(once, URL), { text: once, changed: false });
  const moved = enableProxy(once, "http://127.0.0.1:18000/backend-api/codex");
  assert.equal(moved.changed, true);
  assert.equal(proxyStatus(moved.text).url, "http://127.0.0.1:18000/backend-api/codex");
  assert.equal(disableProxy(moved.text).text, original);
});

test("a user's own top-level openai_base_url is never overwritten", () => {
  const mine = 'openai_base_url = "https://example.test/v1"\n' + original;
  assert.throws(() => enableProxy(mine, URL), /already sets openai_base_url/);
  assert.equal(proxyStatus(mine).conflict, true);
});

test("openai_base_url inside a table is not a top-level conflict", () => {
  const scoped = original + '\n[profiles.work]\nopenai_base_url = "https://example.test/v1"\n';
  assert.equal(enableProxy(scoped, URL).changed, true);
});

test("disable without a managed block changes nothing", () => {
  assert.deepEqual(disableProxy(original), { text: original, changed: false });
});
