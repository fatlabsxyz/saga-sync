import type { Hex } from "./hex.js";

// The normalized log we persist. `eventTopic` (= topics[0]) is kept as an explicit
// field because the chunk builder groups by it; the full `topics` array is also
// kept so each event is self-describing (indexed args live in topics[1..]).
//
// `transactionHash`/`blockHash` are intentionally dropped: they are incompressible
// bloat and unnecessary for state reconstruction. Settled chunks only contain
// finalized events (reorg-safe by construction), so block-hash verification adds
// nothing; protocol-specific validation provides any integrity beyond the digest.
//
// Lives in core because both sides depend on it: the producer writes it, the
// client reconstructs it. The producer's `normalize()` (RpcLog -> CanonicalEvent)
// stays producer-side; only the type is shared.
export type CanonicalEvent = {
  contractAddress: Hex;
  eventTopic: Hex;
  topics: Hex[];
  data: Hex;
  blockNumber: Hex;
  logIndex: Hex;
};
