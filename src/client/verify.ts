import { sha256Hex } from "../hash.js";
import type { ChunkMeta } from "../chunk-builder/manifest.js";
import type { CanonicalEvent } from "../scraper/normalize.js";

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
