import { readFileSync, writeFileSync, renameSync } from "node:fs";
import type { ChunkMeta } from "./seal.js";

export type Manifest = {
  availableStates: Record<string, ChunkMeta[]>;
};

export function readManifest(path: string): Manifest {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Manifest;
    if (!parsed.availableStates || typeof parsed.availableStates !== "object") {
      return { availableStates: {} };
    }
    return parsed;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { availableStates: {} };
    }
    throw new Error(`manifest ${path}: ${(err as Error).message}`);
  }
}

// Append-only: each call adds one entry to availableStates[protocolId]. Atomic
// via temp-file + rename so a crash mid-write cannot leave a half-written
// manifest. Not safe for concurrent appends to the same file.
export function appendToManifest(
  path: string,
  protocolId: string,
  entry: ChunkMeta,
): void {
  const manifest = readManifest(path);
  const list = manifest.availableStates[protocolId] ?? [];
  list.push(entry);
  manifest.availableStates[protocolId] = list;

  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(manifest, null, 2) + "\n", "utf8");
  renameSync(tmp, path);
}
