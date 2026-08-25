import type { PublicClient } from "viem";
import type { CanonicalRecord } from "@saga-sync/core";
import { scrape } from "../scraper/scrape.js";
import { normalize } from "../scraper/normalize.js";
import type { EventFilter } from "../scraper/config.js";
import { finalizedBlock } from "../scraper/cli.js";
import type { ScraperSource } from "./types.js";

// The original source: windowed eth_getLogs against an Ethereum JSON-RPC.
//
// Behaviour is unchanged from when this lived inline in the pipeline — the same
// adaptive window halving on range errors and exponential backoff on rate limits
// (both in scrape()), and the same normalize() to canonical form. Extracting it
// is purely to give the subsquid source something to sit beside.
export class RpcLogSource implements ScraperSource {
  readonly kind = "rpc";

  constructor(
    private readonly client: PublicClient,
    private readonly events: EventFilter[],
    private readonly window: number,
    // The finalized tip, resolved once per orchestrator run and shared by every
    // rpc-sourced stream — one eth_getBlockByNumber("finalized") for the run
    // rather than one per protocol.
    private readonly finalizedTip: bigint,
  ) {}

  async *fetch(fromBlock: bigint, toBlock: bigint): AsyncGenerator<CanonicalRecord> {
    for await (const log of scrape(this.client, {
      fromBlock,
      toBlock,
      events: this.events,
      window: this.window,
    })) {
      yield normalize(log);
    }
  }

  latestCoveredBlock(): Promise<bigint> {
    return Promise.resolve(this.finalizedTip);
  }
}

// Re-exported so the orchestrator resolves the finalized tip through the same
// module that defines what "final" means for this source.
export { finalizedBlock };
