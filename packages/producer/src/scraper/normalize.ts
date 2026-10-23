import type { RpcLog } from "viem";
import type { CanonicalEvent, ExtraLogField, Hex } from "@saga-sync/core";

// `CanonicalEvent` (the persisted log shape) now lives in @saga-sync/core, shared
// with the client which reconstructs it. This module keeps the producer-only
// `normalize()` (viem RpcLog -> CanonicalEvent) and re-exports the type so the
// many producer imports of `../scraper/normalize.js` keep resolving unchanged.
export type { CanonicalEvent } from "@saga-sync/core";

const lower = (hex: string): Hex => hex.toLowerCase() as Hex;

export type NormalizeOptions = {
  // Optional fields to keep beyond the base six, in serialization order (the
  // config canonicalizes it). Empty/absent yields the plain six-field record.
  extraLogFields?: readonly ExtraLogField[];
};

export function normalize(log: RpcLog, opts: NormalizeOptions = {}): CanonicalEvent {
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
  const event: CanonicalEvent = {
    contractAddress: lower(log.address),
    eventTopic: lower(eventTopic),
    topics: log.topics.map(lower),
    data: lower(log.data),
    blockNumber: lower(log.blockNumber),
    logIndex: lower(log.logIndex),
  };
  // Appended after the base six so key order — and so the digest — is fixed.
  for (const field of opts.extraLogFields ?? []) {
    switch (field) {
      case "transactionHash":
        // A declared field is on every record or the stream is malformed, so a
        // log without it is an error rather than a record that silently lacks it.
        if (log.transactionHash == null) {
          throw new Error(
            `log missing transactionHash (block ${log.blockNumber}, logIndex ${log.logIndex})`,
          );
        }
        event.transactionHash = lower(log.transactionHash);
        break;
    }
  }
  return event;
}
