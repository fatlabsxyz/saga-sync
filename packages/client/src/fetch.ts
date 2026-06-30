import type { CanonicalEvent } from "@saga-sync/core";
import type { Store } from "@saga-sync/core";
import type { ChunkMeta } from "@saga-sync/core";
import { verifyDigest, verifyChunkEvents } from "./verify.js";

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

// Gzip decompression via the web-standard DecompressionStream, so the consumer
// read path runs in a browser as well as Node (both ship it). Async, unlike
// node:zlib's gunzipSync — the only behavioral change of the browser refactor.
async function gunzip(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

const utf8 = new TextDecoder();

// Decode a chunk file's compressed bytes: gunzip → verify digest → parse JSONL →
// verify canonical form. Digest verification happens before parsing so a tampered
// chunk never reaches the caller; the canonical-form check (range + ordering, SPEC
// §3.3) then catches a correctly-digested chunk the producer built non-canonically.
// Async because gzip decompression is a streaming Web API.
export async function decodeAndVerify(
  compressed: Uint8Array,
  meta: ChunkMeta,
): Promise<CanonicalEvent[]> {
  // Defensive: a zero-byte file is not produced by the pipeline (an empty
  // events list still gzips to ~20 bytes), but if encountered, hand empty
  // bytes to verify rather than letting gunzip throw.
  const uncompressed = compressed.length === 0 ? new Uint8Array(0) : await gunzip(compressed);
  verifyDigest(meta, uncompressed);
  if (uncompressed.length === 0) return [];
  const events = utf8
    .decode(uncompressed)
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as CanonicalEvent);
  verifyChunkEvents(meta, events);
  return events;
}

// Fetch a chunk from `store`, verify, return its events. Throws
// ChunkNotFoundError if the store has no such object, DigestMismatchError if
// the bytes do not match the manifest.
export async function fetchChunkFrom(store: Store, meta: ChunkMeta): Promise<CanonicalEvent[]> {
  const compressed = await store.get(meta.file);
  if (!compressed) throw new ChunkNotFoundError(meta);
  return decodeAndVerify(compressed, meta);
}
