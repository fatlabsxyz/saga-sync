import type { RpcLog } from "viem";
import type { CanonicalEvent, Hex } from "@saga-sync/core";

// `CanonicalEvent` (the persisted log shape) now lives in @saga-sync/core, shared
// with the client which reconstructs it. This module keeps the producer-only
// `normalize()` (viem RpcLog -> CanonicalEvent) and re-exports the type so the
// many producer imports of `../scraper/normalize.js` keep resolving unchanged.
export type { CanonicalEvent } from "@saga-sync/core";

const lower = (hex: string): Hex => hex.toLowerCase() as Hex;

export function normalize(log: RpcLog): CanonicalEvent {
  const eventTopic = log.topics[0];
  if (!eventTopic) {
    throw new Error(
      `log without topics (tx ${log.transactionHash ?? "?"}, logIndex ${log.logIndex ?? "?"})`,
    );
  }
  if (log.blockNumber == null || log.logIndex == null) {
    throw new Error(
      `log missing block/index fields — pending logs are not scrapable (tx ${log.transactionHash ?? "?"})`,
    );
  }
  return {
    contractAddress: lower(log.address),
    eventTopic: lower(eventTopic),
    topics: log.topics.map(lower),
    data: lower(log.data),
    blockNumber: lower(log.blockNumber),
    logIndex: lower(log.logIndex),
  };
}
