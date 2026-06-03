import { gzipSync, gunzipSync } from "node:zlib";
import { numberToHex } from "viem";
import { sha256Hex } from "../hash.js";
import type { CanonicalEvent } from "../scraper/normalize.js";
import type { Store } from "../storage/store.js";
import type { ChunkMeta } from "./manifest.js";

export type Range = { from: bigint; to: bigint };

// Build the JSONL bytes for a chunk: one CanonicalEvent per line, trailing
// newline. Empty events list produces zero bytes so an empty chunk file is
// genuinely empty rather than a single blank line.
export function buildJsonl(events: CanonicalEvent[]): Buffer {
  if (events.length === 0) return Buffer.alloc(0);
  return Buffer.from(events.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");
}

// Encodes/decodes chunk files over a Store. A chunk's digest is the sha256 of
// the *uncompressed* JSONL bytes — clients verify integrity after decompressing
// without trusting the gzip wrapper. Sealed and hot files are byte-identical for
// the same events; only the filename suffix differs (`.jsonl.gz` vs
// `.hot.jsonl.gz`), a hint that a hot file is the protocol's mutable tail.
//
// Dry-run is handled at the Store layer (DryRunStore no-ops writes), so this
// class needs no dry-run awareness.
export class ChunkArchive {
  constructor(private readonly store: Store) {}

  // Seal an immutable chunk.
  seal(protocolId: string, events: CanonicalEvent[], range: Range): Promise<ChunkMeta> {
    return this.write(protocolId, events, range, false);
  }

  // Write the protocol's mutable hot head.
  writeHotHead(protocolId: string, events: CanonicalEvent[], range: Range): Promise<ChunkMeta> {
    return this.write(protocolId, events, range, true);
  }

  private async write(
    protocolId: string,
    events: CanonicalEvent[],
    range: Range,
    hot: boolean,
  ): Promise<ChunkMeta> {
    const uncompressed = buildJsonl(events);
    const digest = sha256Hex(uncompressed);
    const compressed = gzipSync(uncompressed);

    const fromHex = numberToHex(range.from);
    const toHex = numberToHex(range.to);
    const file = `${protocolId}-[${fromHex},${toHex})${hot ? ".hot.jsonl.gz" : ".jsonl.gz"}`;

    await this.store.put(file, compressed);

    return {
      fromBlock: fromHex,
      toBlock: toHex,
      file,
      size: numberToHex(compressed.length),
      digest: { type: "sha256", data: digest },
    };
  }

  // Inverse of write(): fetch a chunk file and parse its JSONL back into events.
  // Used to load a previous hot head into the accumulator (and by the future
  // client library to materialize chunk contents).
  async readEvents(meta: ChunkMeta): Promise<CanonicalEvent[]> {
    const compressed = await this.store.get(meta.file);
    if (!compressed || compressed.length === 0) return [];
    const uncompressed = gunzipSync(compressed).toString("utf8");
    if (uncompressed.length === 0) return [];
    return uncompressed
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as CanonicalEvent);
  }

  async delete(meta: ChunkMeta): Promise<void> {
    await this.store.delete(meta.file);
  }
}
