import type { CanonicalRecord } from "@saga-sync/core";
import type { ScraperSource } from "../sources/index.js";
import { processStream } from "../chunk-builder/cli.js";
import { ChunkArchive } from "../chunk-builder/archive.js";
import { Manifest } from "@saga-sync/core";
import type { ChunkMeta } from "@saga-sync/core";

export type RunProtocolOptions = {
  // Where the records come from. The pipeline drives ranges and chunking and
  // stays ignorant of whether these are logs off an RPC or an indexer's rows.
  source: ScraperSource;
  protocolId: string;
  fromBlock: bigint;
  toBlock: bigint; // inclusive — same convention as scraper
  sizeLimit: number;
  archive: ChunkArchive;
  manifest: Manifest;
  // Optional: events loaded from the protocol's previous hot head, plus the
  // fromBlock that hot head started at. When set, processStream pre-loads the
  // accumulator so the next sealed chunk's range begins at `hotHead.fromBlock`.
  hotHead?: { events: CanonicalRecord[]; fromBlock: bigint };
  // "seal" (default) seals the trailing partial at EOF; "suspend" returns it
  // for the caller to persist as a hot head.
  trailingMode?: "seal" | "suspend";
};

export type RunProtocolResult = {
  sealed: ChunkMeta[];
  trailing?: { events: CanonicalRecord[]; fromBlock: bigint; toBlock: bigint };
};

// Compose source + chunk-builder in-process: the source yields canonical records,
// we stringify them into NDJSON lines, and processStream consumes them. No
// subprocess, no stdio piping — errors propagate as exceptions.
export async function runProtocolOnce(opts: RunProtocolOptions): Promise<RunProtocolResult> {
  async function* lines(): AsyncGenerator<string> {
    for await (const record of opts.source.fetch(opts.fromBlock, opts.toBlock)) {
      yield JSON.stringify(record);
    }
  }

  return processStream(lines(), {
    protocolId: opts.protocolId,
    fromBlock: opts.fromBlock,
    // scraper's inclusive [from, to] → chunk-builder's half-open [from, to+1)
    toBlock: opts.toBlock + 1n,
    sizeLimit: opts.sizeLimit,
    archive: opts.archive,
    manifest: opts.manifest,
    ...(opts.hotHead && {
      seed: { events: opts.hotHead.events, chunkFrom: opts.hotHead.fromBlock },
    }),
    ...(opts.trailingMode && { trailingMode: opts.trailingMode }),
  });
}
