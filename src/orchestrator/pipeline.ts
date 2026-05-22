import type { PublicClient } from "viem";
import { scrape } from "../scraper/scrape.js";
import { normalize } from "../scraper/normalize.js";
import type { CanonicalEvent } from "../scraper/normalize.js";
import type { EventFilter } from "../scraper/config.js";
import { processStream } from "../chunk-builder/cli.js";
import { ChunkArchive } from "../chunk-builder/archive.js";
import { Manifest } from "../chunk-builder/manifest.js";
import type { ChunkMeta } from "../chunk-builder/manifest.js";

export type RunProtocolOptions = {
  client: PublicClient;
  protocolId: string;
  fromBlock: bigint;
  toBlock: bigint; // inclusive — same convention as scraper
  events: EventFilter[];
  sizeLimit: number;
  window: number;
  archive: ChunkArchive;
  manifest: Manifest;
  // Optional: events loaded from the protocol's previous hot head, plus the
  // fromBlock that hot head started at. When set, processStream pre-loads the
  // accumulator so the next sealed chunk's range begins at `hotHead.fromBlock`.
  hotHead?: { events: CanonicalEvent[]; fromBlock: bigint };
  // "seal" (default) seals the trailing partial at EOF; "suspend" returns it
  // for the caller to persist as a hot head.
  trailingMode?: "seal" | "suspend";
};

export type RunProtocolResult = {
  sealed: ChunkMeta[];
  trailing?: { events: CanonicalEvent[]; fromBlock: bigint; toBlock: bigint };
};

// Compose scraper + chunk-builder in-process: scrape() yields raw logs, we
// normalize and stringify into NDJSON lines, and processStream consumes them.
// No subprocess, no stdio piping — errors propagate as exceptions.
export async function runProtocolOnce(opts: RunProtocolOptions): Promise<RunProtocolResult> {
  async function* lines(): AsyncGenerator<string> {
    for await (const log of scrape(opts.client, {
      fromBlock: opts.fromBlock,
      toBlock: opts.toBlock,
      events: opts.events,
      window: opts.window,
    })) {
      yield JSON.stringify(normalize(log));
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
