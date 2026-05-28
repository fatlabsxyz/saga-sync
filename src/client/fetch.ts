import { gunzipSync } from "node:zlib";
import type { CanonicalEvent } from "../scraper/normalize.js";
import type { Store } from "../storage/store.js";
import type { ChunkMeta } from "../chunk-builder/manifest.js";
import { verifyDigest } from "./verify.js";

// Thrown when a chunk file referenced by the manifest is absent from the
// store. Distinct from DigestMismatchError so callers can tell "missing"
// from "wrong" — typically actionable differently (publisher gap vs. tampering).
export class ChunkNotFoundError extends Error {
  readonly meta: ChunkMeta;
  constructor(meta: ChunkMeta) {
    super(`chunk file not found: ${meta.file}`);
    this.name = "ChunkNotFoundError";
    this.meta = meta;
  }
}

// Decode a chunk file's compressed bytes: gunzip → verify digest → parse JSONL.
// Verification happens before parsing so a tampered chunk never reaches the
// caller in any form. Mirrors ChunkArchive.readEvents on the producer side,
// minus the I/O.
export function decodeAndVerify(compressed: Buffer, meta: ChunkMeta): CanonicalEvent[] {
  // Defensive: a zero-byte file is not produced by the pipeline (an empty
  // events list still gzips to ~20 bytes), but if encountered, hand an empty
  // buffer to verify rather than letting gunzip throw.
  const uncompressed = compressed.length === 0 ? Buffer.alloc(0) : gunzipSync(compressed);
  verifyDigest(meta, uncompressed);
  if (uncompressed.length === 0) return [];
  return uncompressed
    .toString("utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as CanonicalEvent);
}

// Fetch a chunk from `store`, verify, return its events. Throws
// ChunkNotFoundError if the store has no such object, DigestMismatchError if
// the bytes do not match the manifest.
export async function fetchChunkFrom(store: Store, meta: ChunkMeta): Promise<CanonicalEvent[]> {
  const compressed = await store.get(meta.file);
  if (!compressed) throw new ChunkNotFoundError(meta);
  return decodeAndVerify(compressed, meta);
}
