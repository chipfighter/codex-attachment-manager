// Purpose: one place for where the tool keeps its own data (selection state, request statistics, logs, backups).
// Input: CAM_DATA_DIR when set; otherwise a per-user folder: %LOCALAPPDATA%\codex-attachment-manager on Windows,
// $XDG_DATA_HOME (or ~/.local/share)/codex-attachment-manager elsewhere. Never inside the plugin folder, which Codex
// replaces on every update, and never under ~/.codex.
// Output: absolute directory paths. Nothing here writes anything.

import { homedir } from "node:os";
import { join } from "node:path";

export function dataDir(): string {
  const chosen = process.env.CAM_DATA_DIR?.trim();
  if (chosen) return chosen;
  if (process.platform === "win32") return join(process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "codex-attachment-manager");
  return join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "codex-attachment-manager");
}

export const selectionDirOf = (root = dataDir()) => join(root, "selection");
export const requestStatsDirOf = (root = dataDir()) => join(root, "state", "requests");
export const proxyLogDirOf = (root = dataDir()) => join(root, "proxy");
