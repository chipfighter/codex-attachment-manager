// Purpose: v0.1 — the places that differ between Windows, macOS and Linux: the data folder, where Codex's command line
// is looked for, and how the plugin's launcher is started. Each platform is checked on any machine.
// Input: synthetic environments and home folders; output: Node test assertions only.

import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { launcher } from "../../plugin/src/cam.ts";
import { cliCandidates } from "../../plugin/src/codexcli.ts";
import { dataDir } from "../../plugin/src/paths.ts";

const home = join("/", "home", "someone");

test("the data folder follows each platform's convention, and CAM_DATA_DIR wins", () => {
  assert.equal(dataDir({ LOCALAPPDATA: join("C:", "Users", "someone", "AppData", "Local") }, "win32", home), join("C:", "Users", "someone", "AppData", "Local", "codex-attachment-manager"));
  assert.equal(dataDir({}, "darwin", home), join(home, "Library", "Application Support", "codex-attachment-manager"));
  assert.equal(dataDir({}, "linux", home), join(home, ".local", "share", "codex-attachment-manager"));
  assert.equal(dataDir({ XDG_DATA_HOME: join(home, "data") }, "linux", home), join(home, "data", "codex-attachment-manager"));
  assert.equal(dataDir({ CAM_DATA_DIR: join(home, "chosen") }, "darwin", home), join(home, "chosen"));
});

test("Codex's command line is looked for in the desktop app first, then where Codex's installer puts it", () => {
  const mac = cliCandidates({}, "darwin", home);
  assert.equal(mac[0], join("/Applications", "ChatGPT.app", "Contents", "Resources", "codex"));
  assert.ok(mac.includes(join("/Applications", "Codex.app", "Contents", "Resources", "codex")));
  assert.equal(mac.at(-1), join(home, ".local", "bin", "codex"));
  assert.deepEqual(cliCandidates({}, "linux", home), [join(home, ".local", "bin", "codex")]);
});

test("the launcher runs through cmd.exe on Windows and as an executable script elsewhere", () => {
  assert.deepEqual(launcher("./src/cam.ts", "win32"), ["cmd.exe", ["/d", "/s", "/c", "call", "./scripts/launch.cmd", "./src/cam.ts"]]);
  assert.deepEqual(launcher("./src/cam.ts", "linux"), ["./scripts/launch", ["./src/cam.ts"]]);
});
