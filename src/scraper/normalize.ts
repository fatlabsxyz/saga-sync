import type { Hex, RpcLog } from "viem";

// The normalized log we persist. `eventTopic` (= topics[0]) is kept as an explicit
// field because the chunk builder groups by it; the full `topics` array is also
// kept so each event is self-describing (indexed args live in topics[1..]).
//
// `transactionHash`/`blockHash` are intentionally dropped: they are incompressible
// bloat and unnecessary for state reconstruction. Settled chunks only contain
// finalized events (reorg-safe by construction), so block-hash verification adds
// nothing; protocol-specific validation provides any integrity beyond the digest.
export type CanonicalEvent = {
  contractAddress: Hex;
  eventTopic: Hex;
  topics: Hex[];
  data: Hex;
  blockNumber: Hex;
  logIndex: Hex;
};

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
