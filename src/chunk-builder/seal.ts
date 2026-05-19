import { readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";
import { numberToHex } from "viem";
import type { Hex } from "viem";
import { blake3 } from "@noble/hashes/blake3.js";
import type { CanonicalEvent } from "../scraper/normalize.js";

export type ChunkMeta = {
  fromBlock: Hex;
  toBlock: Hex;
  file: string;
  size: Hex;
  digest: { type: "blake3"; data: Hex };
};

export type SealOptions = {
  outputDir: string;
  protocolId: string;
  dryRun: boolean;
  // When true, the produced file gets a `.hot.jsonl.gz` suffix instead of
  // `.jsonl.gz`. Hot files are still immutable at their URL (each rewrite
  // has a different toBlock and therefore a different filename) — the `.hot.`
  // infix is just a hint to clients/cleanup routines that the file is the
  // protocol's current mutable tail.
  hot?: boolean;
};

// Build the JSONL bytes for a chunk: one CanonicalEvent per line, trailing
// newline. Empty events list produces zero bytes so an empty chunk file is
// genuinely empty rather than a single blank line.
export function buildJsonl(events: CanonicalEvent[]): Buffer {
  if (events.length === 0) return Buffer.alloc(0);
  return Buffer.from(events.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");
}

// digest = blake3 of the uncompressed JSONL bytes (not of the gzipped file).
// Storing the uncompressed digest lets clients verify integrity after decompressing
// without trusting the gzip wrapper.
export function sealChunk(
  events: CanonicalEvent[],
  range: { from: bigint; to: bigint },
  opts: SealOptions,
): ChunkMeta {
  const uncompressed = buildJsonl(events);
  const digestBytes = blake3(uncompressed);
  const digestHex = `0x${Buffer.from(digestBytes).toString("hex")}` as Hex;
  const compressed = gzipSync(uncompressed);

  const fromHex = numberToHex(range.from);
  const toHex = numberToHex(range.to);
  const suffix = opts.hot ? ".hot.jsonl.gz" : ".jsonl.gz";
  const file = `${opts.protocolId}-[${fromHex},${toHex})${suffix}`;

  if (!opts.dryRun) {
    const finalPath = join(opts.outputDir, file);
    const tmpPath = `${finalPath}.${process.pid}.tmp`;
    writeFileSync(tmpPath, compressed);
    renameSync(tmpPath, finalPath);
  }

  return {
    fromBlock: fromHex,
    toBlock: toHex,
    file,
    size: numberToHex(compressed.length),
    digest: { type: "blake3", data: digestHex },
  };
}

// Inverse of sealChunk for its content: gunzip + parse JSONL → CanonicalEvent[].
// Used by the orchestrator to load a previous hot head back into the accumulator,
// and (eventually) by the client library to materialize chunk contents.
export function readChunkFile(path: string): CanonicalEvent[] {
  const compressed = readFileSync(path);
  if (compressed.length === 0) return [];
  const uncompressed = gunzipSync(compressed).toString("utf8");
  if (uncompressed.length === 0) return [];
  return uncompressed
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as CanonicalEvent);
}
