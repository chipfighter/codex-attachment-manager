// Purpose: one place for where the tool keeps its own data (selection state, request statistics, logs, backups).
// Input: CAM_DATA_DIR when set; otherwise a per-user folder: %LOCALAPPDATA%\codex-attachment-manager on Windows,
// ~/Library/Application Support/codex-attachment-manager on macOS, $XDG_DATA_HOME (or ~/.local/share)/
// codex-attachment-manager on Linux. Never inside the plugin folder, which Codex replaces on every update, and never
// under ~/.codex.
// Output: absolute directory paths. Nothing here writes anything.

import { homedir } from "node:os";
import { join } from "node:path";

export function dataDir(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, home = homedir()): string {
  const chosen = env.CAM_DATA_DIR?.trim();
  if (chosen) return chosen;
  if (platform === "win32") return join(env.LOCALAPPDATA || join(home, "AppData", "Local"), "codex-attachment-manager");
  if (platform === "darwin") return join(home, "Library", "Application Support", "codex-attachment-manager");
  return join(env.XDG_DATA_HOME || join(home, ".local", "share"), "codex-attachment-manager");
}

export const selectionDirOf = (root = dataDir()) => join(root, "selection");
export const requestStatsDirOf = (root = dataDir()) => join(root, "state", "requests");
export const proxyLogDirOf = (root = dataDir()) => join(root, "proxy");
