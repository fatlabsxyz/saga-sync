import type { Hex } from "./hex.js";

// What a chunk holds, one JSON object per line. Two shapes:
//
//  - CanonicalEvent  — a normalized chain LOG. The original and, for every
//    protocol served from `eth_getLogs`, the only one.
//  - CanonicalEntity — a record that is NOT a chain log: something an indexer
//    derived from data no log carries (Railgun's per-transaction operations live
//    only in `transact()` calldata). Kept structurally distinct on purpose — a
//    consumer must be able to tell "this came off the chain as a log" from "this
//    is someone's derivation", because only the former is verifiable against an
//    archive node.
//
// Both carry `blockNumber`, which is all the chunker and the range checks need,
// so the two can share every piece of plumbing between the scraper and the client.

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

// An indexer-derived record. `entity` names the record kind and is the field that
// distinguishes it from a log on the wire.
//
// The ordering triple is deliberately chain-native — (block, transaction, index
// within that transaction) — rather than an indexer's own row id. That is what
// lets a later, independently-derived source emit byte-identical records: the key
// describes where the thing happened on chain, not where it sat in someone's
// database. It mirrors a log's (blockNumber, logIndex) exactly.
//
// Payload fields live alongside these and are opaque to the spec, the same way a
// log's `data` is.
export type CanonicalEntity = {
  readonly entity: string;
  readonly blockNumber: Hex;
  readonly transactionIndex: Hex;
  readonly opIndex: Hex;
  readonly [field: string]: unknown;
};

// What the pipeline moves around: a chunk is a sequence of one or the other.
// A single stream never mixes them (see verifyChunkEvents).
export type CanonicalRecord = CanonicalEvent | CanonicalEntity;

// Narrow a record. Discriminating on the presence of `entity` keeps a log's shape
// byte-identical to what it has always been — no version field, no wrapper, and
// every chunk published before entities existed still parses unchanged.
export function isEntityRecord(record: CanonicalRecord): record is CanonicalEntity {
  return typeof (record as CanonicalEntity).entity === "string";
}
