import type { CanonicalRecord } from "@saga-sync/core";

// Where a stream's records come from.
//
// The pipeline used to call scrape() + normalize() directly, which baked
// "records are logs from an Ethereum RPC" into the orchestrator. That is true for
// every protocol served from eth_getLogs, and false for anything whose data no
// log carries — Railgun's per-transaction operations live only in transact()
// calldata. This interface is the seam: the orchestrator drives block ranges and
// chunking, a source decides where the bytes come from.
export type ScraperSource = {
  // Records for the INCLUSIVE range [fromBlock, toBlock], in ascending canonical
  // order. Ascending order is not a nicety: the chunk builder assumes it (it
  // seals on block boundaries) and the client re-verifies it on every chunk.
  fetch(fromBlock: bigint, toBlock: bigint): AsyncGenerator<CanonicalRecord>;

  // The highest block this source can be trusted to have complete, final data
  // for. The orchestrator scrapes up to it and no further.
  //
  // "Final" is the load-bearing word. Sealed chunks are immutable, so a source
  // must never report a block that could still be reorged out — see the clamp in
  // SubsquidSource, whose index runs ahead of finality.
  latestCoveredBlock(): Promise<bigint>;

  // For diagnostics — appears in orchestrator logs.
  readonly kind: string;
};
