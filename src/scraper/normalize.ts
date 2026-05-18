import type { Hex, RpcLog } from "viem";

// The full normalized log. `eventTopic` (= topics[0]) is kept as an explicit field
// because the chunk builder groups by it; the full `topics` array is also kept so
// each event is self-describing. Nothing is dropped here — any lossy projection is
// the chunk builder's choice, not the scraper's.
export type CanonicalEvent = {
  contractAddress: Hex;
  eventTopic: Hex;
  topics: Hex[];
  data: Hex;
  blockNumber: Hex;
  logIndex: Hex;
  transactionHash: Hex;
  blockHash: Hex;
};

const lower = (hex: string): Hex => hex.toLowerCase() as Hex;

export function normalize(log: RpcLog): CanonicalEvent {
  const eventTopic = log.topics[0];
  if (!eventTopic) {
    throw new Error(
      `log without topics (tx ${log.transactionHash ?? "?"}, logIndex ${log.logIndex ?? "?"})`,
    );
  }
  if (
    log.blockNumber == null ||
    log.blockHash == null ||
    log.logIndex == null ||
    log.transactionHash == null
  ) {
    throw new Error(
      `log missing block/tx fields — pending logs are not scrapable (tx ${log.transactionHash ?? "?"})`,
    );
  }
  return {
    contractAddress: lower(log.address),
    eventTopic: lower(eventTopic),
    topics: log.topics.map(lower),
    data: lower(log.data),
    blockNumber: lower(log.blockNumber),
    logIndex: lower(log.logIndex),
    transactionHash: lower(log.transactionHash),
    blockHash: lower(log.blockHash),
  };
}
