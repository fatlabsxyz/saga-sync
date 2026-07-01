import { sha256Hex } from "@saga-sync/core";
import type { ChunkMeta } from "@saga-sync/core";
import type { CanonicalEvent } from "@saga-sync/core";

// Thrown when a chunk's recomputed digest does not match the manifest. Carries
// both digests so the caller can log them; both are lower-case 0x-prefixed.
export class DigestMismatchError extends Error {
  readonly meta: ChunkMeta;
  readonly expected: string;
  readonly actual: string;
  constructor(meta: ChunkMeta, expected: string, actual: string) {
    super(
      `digest mismatch for ${meta.file}: expected ${expected}, got ${actual}`,
    );
    this.name = "DigestMismatchError";
    this.meta = meta;
    this.expected = expected;
    this.actual = actual;
  }
}

// Recompute the sha256 of the chunk's uncompressed JSONL bytes and compare to
// the manifest entry. Mandatory on every fetched chunk (cache hits included) —
// the whole point of the system is verifiable distribution.
export function verifyDigest(meta: ChunkMeta, uncompressed: Uint8Array): void {
  if (meta.digest.type !== "sha256") {
    throw new Error(`unsupported digest type ${meta.digest.type} for ${meta.file}`);
  }
  const expected = normalize(meta.digest.data);
  const actual = sha256Hex(uncompressed);
  if (expected !== actual) {
    throw new DigestMismatchError(meta, expected, actual);
  }
}

function normalize(hex: string): string {
  const s = hex.toLowerCase();
  return s.startsWith("0x") ? s : `0x${s}`;
}

// Thrown when a chunk's events violate the canonical form (SPEC §3.3) the digest
// cannot catch on its own: out-of-range blocks, or a non-ascending order. The
// digest proves the bytes match the manifest; this proves the manifest author
// honored the ordering + range contract (defense against a buggy, even if
// trusted, producer).
export class CanonicalFormError extends Error {
  readonly meta: ChunkMeta;
  constructor(meta: ChunkMeta, detail: string) {
    super(`chunk ${meta.file} violates canonical form: ${detail}`);
    this.name = "CanonicalFormError";
    this.meta = meta;
  }
}

// Validate the two §3.3 properties the digest does not *semantically* enforce:
//   1. every event's blockNumber is within the chunk's [fromBlock, toBlock) range
//   2. events are strictly ascending by (blockNumber, logIndex)
// Empty chunks pass trivially. Mandatory on every chunk, like the digest.
export function verifyChunkEvents(meta: ChunkMeta, events: CanonicalEvent[]): void {
  const from = BigInt(meta.fromBlock);
  const to = BigInt(meta.toBlock);
  let prevBlock = -1n;
  let prevLog = -1n;
  let first = true;
  for (const e of events) {
    const block = BigInt(e.blockNumber);
    const log = BigInt(e.logIndex);
    if (block < from || block >= to) {
      throw new CanonicalFormError(
        meta,
        `event at block ${e.blockNumber} is outside [${meta.fromBlock},${meta.toBlock})`,
      );
    }
    if (!first && (block < prevBlock || (block === prevBlock && log <= prevLog))) {
      throw new CanonicalFormError(
        meta,
        `events not strictly ascending by (blockNumber, logIndex) at block ${e.blockNumber}, logIndex ${e.logIndex}`,
      );
    }
    prevBlock = block;
    prevLog = log;
    first = false;
  }
}
