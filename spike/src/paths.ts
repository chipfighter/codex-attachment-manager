// Purpose: one place for where the tool keeps its own data (selection state, request statistics, logs).
// Input: CAM_DATA_DIR when set; otherwise the repository's git-ignored local/ folder (spike phase).
// Output: absolute directory paths. Nothing here writes to ~/.codex.

import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function dataDir(): string {
  return process.env.CAM_DATA_DIR?.trim() || join(resolve(dirname(fileURLToPath(import.meta.url)), "../.."), "local");
}

export const selectionDirOf = (root = dataDir()) => join(root, "selection");
export const requestStatsDirOf = (root = dataDir()) => join(root, "state", "requests");
export const proxyLogDirOf = (root = dataDir()) => join(root, "proxy");
