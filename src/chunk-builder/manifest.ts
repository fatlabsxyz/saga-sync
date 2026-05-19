import { readFileSync, writeFileSync, renameSync } from "node:fs";
import type { ChunkMeta } from "./seal.js";

export type Manifest = {
  availableStates: Record<string, ChunkMeta[]>;
  // At most one mutable "hot head" entry per protocol — the trailing partial
  // chunk that grows across orchestrator ticks until it reaches size_limit.
  // Optional so the field can be absent on older manifests and on cold-start.
  hotHeads?: Record<string, ChunkMeta>;
};

export function readManifest(path: string): Manifest {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Manifest;
    const manifest: Manifest = {
      availableStates:
        parsed.availableStates && typeof parsed.availableStates === "object"
          ? parsed.availableStates
          : {},
    };
    if (parsed.hotHeads && typeof parsed.hotHeads === "object") {
      manifest.hotHeads = parsed.hotHeads;
    }
    return manifest;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { availableStates: {} };
    }
    throw new Error(`manifest ${path}: ${(err as Error).message}`);
  }
}

function writeManifestAtomic(path: string, manifest: Manifest): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(manifest, null, 2) + "\n", "utf8");
  renameSync(tmp, path);
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
  writeManifestAtomic(path, manifest);
}

// Set (or replace) the hot head for one protocol. Atomic. Same temp-file pattern.
export function setHotHead(path: string, protocolId: string, entry: ChunkMeta): void {
  const manifest = readManifest(path);
  const hotHeads = manifest.hotHeads ?? {};
  hotHeads[protocolId] = entry;
  manifest.hotHeads = hotHeads;
  writeManifestAtomic(path, manifest);
}

// Remove the hot head for one protocol (e.g., after promotion to sealed chunk
// with no leftover events). Atomic. No-op if there's no hot head to clear.
export function clearHotHead(path: string, protocolId: string): void {
  const manifest = readManifest(path);
  if (!manifest.hotHeads || !(protocolId in manifest.hotHeads)) return;
  delete manifest.hotHeads[protocolId];
  if (Object.keys(manifest.hotHeads).length === 0) delete manifest.hotHeads;
  writeManifestAtomic(path, manifest);
}
