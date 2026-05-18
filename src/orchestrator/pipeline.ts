import type { PublicClient } from "viem";
import { scrape } from "../scraper/scrape.js";
import { normalize } from "../scraper/normalize.js";
import type { EventFilter } from "../scraper/config.js";
import { processStream } from "../chunk-builder/cli.js";
import type { ChunkMeta } from "../chunk-builder/seal.js";

export type RunProtocolOptions = {
  client: PublicClient;
  protocolId: string;
  fromBlock: bigint;
  toBlock: bigint; // inclusive — same convention as scraper
  events: EventFilter[];
  sizeLimit: number;
  outputDir: string;
  window: number;
  dryRun?: boolean;
};

// Compose scraper + chunk-builder in-process: scrape() yields raw logs, we
// normalize and stringify into NDJSON lines, and processStream consumes them.
// No subprocess, no stdio piping — errors from either side propagate as
// exceptions and the caller decides whether to advance state.
export async function runProtocolOnce(opts: RunProtocolOptions): Promise<ChunkMeta[]> {
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
    outputDir: opts.outputDir,
    sizeLimit: opts.sizeLimit,
    dryRun: opts.dryRun ?? false,
  });
}
