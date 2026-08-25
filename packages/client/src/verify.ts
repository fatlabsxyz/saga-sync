import { sha256Hex } from "@saga-sync/core";
import type { ChunkMeta } from "@saga-sync/core";
import type { CanonicalRecord } from "@saga-sync/core";
import { isEntityRecord } from "@saga-sync/core";

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

// A record's position in the total order. Logs sort by (blockNumber, logIndex);
// indexer-derived entities by (blockNumber, transactionIndex, opIndex) — both are
// chain coordinates, so the two schemes are the same idea at different
// granularity. Returned as an array so one comparison covers both.
function sortKey(record: CanonicalRecord): bigint[] {
  return isEntityRecord(record)
    ? [BigInt(record.blockNumber), BigInt(record.transactionIndex), BigInt(record.opIndex)]
    : [BigInt(record.blockNumber), BigInt(record.logIndex)];
}

// Lexicographic compare of two equal-length keys. -1 / 0 / 1.
function compareKeys(a: bigint[], b: bigint[]): number {
  for (let i = 0; i < a.length; i++) {
    if (a[i]! < b[i]!) return -1;
    if (a[i]! > b[i]!) return 1;
  }
  return 0;
}

function describe(record: CanonicalRecord): string {
  const k = sortKey(record);
  return isEntityRecord(record)
    ? `(block ${record.blockNumber}, tx ${record.transactionIndex}, op ${record.opIndex})`
    : `(block ${record.blockNumber}, logIndex ${(record as { logIndex: string }).logIndex})`;
}

// Validate the §3.3 properties the digest does not *semantically* enforce:
//   1. every record's blockNumber is within the chunk's [fromBlock, toBlock) range
//   2. records are strictly ascending by their sort key
//   3. a chunk holds one KIND of record — logs or entities, never a mix
// Empty chunks pass trivially. Mandatory on every chunk, like the digest.
//
// (3) matters because the two kinds carry different provenance: a log is
// verifiable against an archive node, an entity is someone's derivation. Letting
// them interleave in one stream would let a derived record hide among records
// that can be independently checked.
export function verifyChunkEvents(meta: ChunkMeta, events: CanonicalRecord[]): void {
  const from = BigInt(meta.fromBlock);
  const to = BigInt(meta.toBlock);
  let prevKey: bigint[] | null = null;
  let kind: "log" | "entity" | null = null;

  for (const record of events) {
    const thisKind = isEntityRecord(record) ? "entity" : "log";
    if (kind === null) {
      kind = thisKind;
    } else if (kind !== thisKind) {
      throw new CanonicalFormError(
        meta,
        `mixes ${kind} and ${thisKind} records; a stream carries one kind`,
      );
    }

    const block = BigInt(record.blockNumber);
    if (block < from || block >= to) {
      throw new CanonicalFormError(
        meta,
        `record at block ${record.blockNumber} is outside [${meta.fromBlock},${meta.toBlock})`,
      );
    }

    const key = sortKey(record);
    if (prevKey !== null && compareKeys(key, prevKey) <= 0) {
      throw new CanonicalFormError(
        meta,
        `records not strictly ascending at ${describe(record)}`,
      );
    }
    prevKey = key;
  }
}
