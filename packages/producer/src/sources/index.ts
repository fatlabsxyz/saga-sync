import type { PublicClient } from "viem";
import type { ScraperTarget } from "../scraper/config.js";
import type { ScraperSource } from "./types.js";
import { RpcLogSource } from "./rpc-log-source.js";
import { SubsquidSource } from "./subsquid-source.js";
import { CalldataSource } from "./calldata-source.js";

export type { ScraperSource } from "./types.js";
export { RpcLogSource } from "./rpc-log-source.js";
export { SubsquidSource, decodeSquidId, toCanonicalOperation } from "./subsquid-source.js";
export { CalldataSource, callOperations, decodeTransactions, hashBoundParams } from "./calldata-source.js";
export { railgunOperation, NO_UTXO_OUTPUT, RAILGUN_OPERATION_ENTITY } from "./railgun-operation.js";

export type CreateSourceOptions = {
  client: PublicClient;
  window: number;
  // The chain's finalized tip for this run. Every source is bounded by it: the
  // rpc source because that is its tip outright, the subsquid source because its
  // index runs ahead of finality and sealed chunks are immutable.
  finalizedTip: bigint;
  fetchImpl?: typeof fetch;
};

// The single switch point from config to source — mirrors createStore() in
// ../storage/index.ts. Adding a source kind means one case here and one class.
export function createSource(target: ScraperTarget, opts: CreateSourceOptions): ScraperSource {
  switch (target.source.kind) {
    case "rpc":
      if (!target.events) {
        // Unreachable via config (the schema requires events for rpc), but a
        // programmatic caller could get here.
        throw new Error('an "rpc" source requires event filters');
      }
      return new RpcLogSource(opts.client, target.events, opts.window, opts.finalizedTip);
    case "calldata":
      return new CalldataSource({
        client: opts.client,
        address: target.source.address,
        window: opts.window,
        finalizedTip: opts.finalizedTip,
      });
    case "subsquid":
      return new SubsquidSource({
        endpoint: target.source.endpoint,
        entity: target.source.entity,
        finalizedTip: opts.finalizedTip,
        ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
      });
  }
}
