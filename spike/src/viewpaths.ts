// Purpose: attribute a view_image output image to the file it came from.
// Input: candidate paths from the same call's ImageView events and the image's byte SHA-256.
// Output: the matching path, or null when no candidate file has the same bytes.

import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";

export async function fileSha256(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

// Parallel view_image calls complete out of order, so event order cannot be trusted for pairing.
export async function pathForViewedImage(candidates: string[], byteSha256: string, fileHashes: Map<string, string | null>): Promise<string | null> {
  for (const candidate of candidates) {
    if (!fileHashes.has(candidate)) fileHashes.set(candidate, existsSync(candidate) ? await fileSha256(candidate) : null);
    if (fileHashes.get(candidate) === byteSha256) return candidate;
  }
  return null;
}
