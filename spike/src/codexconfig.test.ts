// Purpose: P1-1 — the managed config.toml settings are inserted and removed without touching anything else.
// Input: synthetic config texts; output: Node test assertions only.

import assert from "node:assert/strict";
import test from "node:test";
import { disableProxy, enableProxy, proxyStatus } from "./codexconfig.ts";

const URL = "http://localhost:17891/backend-api/codex";
const withFeatures = 'model = "gpt-6-sol"\n\n[features]\nview_image = true\n\n[mcp_servers.demo]\ncommand = "node"\n';
const withoutFeatures = 'model = "gpt-6-sol"\n\n[mcp_servers.demo]\ncommand = "node"\n';

function topLevelKeys(text: string): string[] {
  const keys: string[] = [];
  for (const line of text.replace(/^﻿/, "").split(/\r?\n/)) {
    if (/^\s*\[/.test(line)) break;
    const key = /^\s*([A-Za-z0-9_.-]+)\s*=/.exec(line)?.[1];
    if (key) keys.push(key);
  }
  return keys;
}

function tableKeys(text: string, table: string): string[] {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === `[${table}]`);
  const keys: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^\s*\[/.test(line)) break;
    const key = /^\s*([A-Za-z0-9_.-]+)\s*=/.exec(line)?.[1];
    if (key) keys.push(key);
  }
  return keys;
}

test("enable puts openai_base_url at top level, before every table", () => {
  const { text, changed } = enableProxy(withFeatures, URL);
  assert.equal(changed, true);
  assert.deepEqual(topLevelKeys(text), ["openai_base_url", "model"]);
  assert.match(text, /openai_base_url = "http:\/\/localhost:17891\/backend-api\/codex"/);
});

test("respect_system_proxy goes into an existing [features] table", () => {
  const { text } = enableProxy(withFeatures, URL);
  assert.deepEqual(tableKeys(text, "features"), ["respect_system_proxy", "view_image"]);
  assert.equal(proxyStatus(text).respectSystemProxy, "managed");
});

test("without a [features] table it becomes a top-level dotted key", () => {
  const { text } = enableProxy(withoutFeatures, URL);
  assert.deepEqual(topLevelKeys(text), ["openai_base_url", "features.respect_system_proxy", "model"]);
  assert.doesNotMatch(text, /^\[features\]/m);
});

test("enable then disable restores the file byte for byte", () => {
  const samples = [withFeatures, withoutFeatures, "", "﻿" + withFeatures.replaceAll("\n", "\r\n"), "# only a comment\n"];
  for (const sample of samples) assert.equal(disableProxy(enableProxy(sample, URL).text).text, sample);
});

test("CRLF files get CRLF blocks and keep their BOM", () => {
  const crlf = "﻿" + withFeatures.replaceAll("\n", "\r\n");
  const { text } = enableProxy(crlf, URL);
  assert.ok(text.startsWith("﻿# >>>"));
  assert.doesNotMatch(text.replaceAll("\r\n", ""), /\n/, "no bare LF introduced");
});

test("enabling twice is a no-op, and a new URL only replaces the managed setting", () => {
  const once = enableProxy(withFeatures, URL).text;
  assert.deepEqual(enableProxy(once, URL), { text: once, changed: false });
  const moved = enableProxy(once, "http://localhost:18000/backend-api/codex");
  assert.equal(moved.changed, true);
  assert.equal(proxyStatus(moved.text).url, "http://localhost:18000/backend-api/codex");
  assert.equal(disableProxy(moved.text).text, withFeatures);
});

test("a user's own top-level openai_base_url is never overwritten", () => {
  const mine = 'openai_base_url = "https://example.test/v1"\n' + withFeatures;
  assert.throws(() => enableProxy(mine, URL), /already sets openai_base_url/);
  assert.equal(proxyStatus(mine).conflict, true);
});

test("openai_base_url inside a table is not a top-level conflict", () => {
  const scoped = withFeatures + '\n[profiles.work]\nopenai_base_url = "https://example.test/v1"\n';
  assert.equal(enableProxy(scoped, URL).changed, true);
});

test("a user's own respect_system_proxy is respected", () => {
  const on = withFeatures.replace("[features]\n", "[features]\nrespect_system_proxy = true\n");
  const enabled = enableProxy(on, URL).text;
  assert.deepEqual(tableKeys(enabled, "features"), ["respect_system_proxy", "view_image"], "not duplicated");
  assert.equal(proxyStatus(enabled).respectSystemProxy, "user");
  assert.equal(disableProxy(enabled).text, on);
  const off = withFeatures.replace("[features]\n", "[features]\nrespect_system_proxy = false\n");
  assert.throws(() => enableProxy(off, URL), /turns respect_system_proxy off/);
});

test("disable without managed settings changes nothing", () => {
  assert.deepEqual(disableProxy(withFeatures), { text: withFeatures, changed: false });
});
