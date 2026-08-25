# Railgun — consuming the `railgun-1-smartwallet` stream

How to rebuild RAILGUN's UTXO state from the published event stream, and what the
stream deliberately does not carry.

This is a **consumer guide**, not spec. The wire format is in
[SPEC.md](../SPEC.md); the stream itself is just `CanonicalEvent` records like any
other, so nothing here changes how the client works.

---

## 1. What the stream is

One stream, `railgun-1-smartwallet`, carrying every note-bearing log emitted by
the **RailgunSmartWallet** proxy on Ethereum mainnet:

| | |
|---|---|
| contract | `0xfa7093cdd9ee6932b4eb2c9e1cde7ce00b1fa4b9` |
| chain | `0x1` |
| first block | `0xe03295` (14,693,013) — the proxy's deployment |
| tree depth | 16 (65,536 leaves per tree) |

The proxy has been upgraded in place three times (V1 → V2.0 → V2.1) and **the
event signatures changed across those upgrades**, so the stream contains three
generations of events. A consumer that only knows the current signatures will
silently miss the first 3,746 leaves; one that only knows the V2.0 `Shield` will
miss ~98% of all shields. All eight topics are tracked, and are also published in
the manifest under `protocolMetadata.events` so the stream is self-describing:

```bash
state-client info https://storage.googleapis.com/pp-state/ railgun-1-smartwallet --json
```

## 2. The events

| topic0 | signature | era | carries |
|---|---|---|---|
| `0xf75eaa09…d71c` | `GeneratedCommitmentBatch(uint256,uint256,(uint256,(uint8,address,uint256),uint120)[],uint256[2][])` | V1 | shield leaves (preimage) |
| `0xc82d2326…9de9` | `CommitmentBatch(uint256,uint256,uint256[],(uint256[4],uint256[2],uint256[])[])` | V1 | transact leaves (`hash[]`) |
| `0x78b6af10…bd09` | `Nullifiers(uint256,uint256[])` | V1 | spends |
| `0xc3821e11…4f34` | `Shield(uint256,uint256,(bytes32,(uint8,address,uint256),uint120)[],(bytes32[3],bytes32)[])` | V2.0 | shield leaves |
| `0x3a5b9dc2…db3b` | `Shield(…same…,uint256[])` | **V2.1, current** | shield leaves + fees |
| `0x56a618cd…a7d1` | `Transact(uint256,uint256,bytes32[],(bytes32[4],bytes32,bytes32,bytes,bytes)[])` | V2 | transact leaves |
| `0xd93cf895…5284` | `Unshield(address,(uint8,address,uint256),uint256,uint256)` | V2 | exits |
| `0x781745c5…b11f` | `Nullified(uint16,bytes32[])` | V2 | spends |

Observed era boundaries (useful for range-scoped work, not normative): V1 events
run 14,751,290 → 16,075,132; V2.0 `Shield` runs 16,077,369 → 16,788,910; V2.1
`Shield` is the only one emitted from 16,790,865 onward.

The contract also emits six admin/config events (13 logs in 11M blocks). They
carry no note data and are not tracked.

## 3. Rebuilding the tree

**Leaf position.** Every commitment-bearing event is a *batch*. The `i`-th
commitment in an event's array sits at:

```
treePosition = startPosition + i
globalPosition = treeNumber * 65536 + treePosition
```

Use the global position as the leaf's identity — `treePosition` may overflow past
`65536`, and the split between `treeNumber` and `treePosition` is not stable
across sources. (This is what kohaku's `normalize_tree_position` does.)

**Leaf hash.** Two of the four commitment kinds hand you the hash directly; two
hand you the preimage and expect Poseidon:

| kind | source event | leaf hash |
|---|---|---|
| transact | `Transact` | `hash[i]` — in the log |
| legacy-encrypted | `CommitmentBatch` | `hash[i]` — in the log |
| shield | `Shield` (either variant) | `poseidon([npk, tokenHash, value])` from `commitments[i]` |
| legacy-generated | `GeneratedCommitmentBatch` | same, from `commitments[i]` |

`npk` is `bytes32` on `Shield` and `uint256` on `GeneratedCommitmentBatch` — the
same field element, two encodings.

**Spends.** `Nullified` and legacy `Nullifiers` both yield
`(treeNumber, nullifier)` pairs; the nullifier is `bytes32` on the former and
`uint256` on the latter. Normalize to 32-byte hex.

**Unshields.** `Unshield` is one log per exit. It is not needed to track spends —
those are already covered by the nullifier events — but it identifies the
recipient, asset, amount, and fee.

## 4. Mapping to kohaku

[`ethereum/kohaku`](https://github.com/ethereum/kohaku) (`crates/railgun`) syncs
Railgun through a `UtxoSyncer` — a two-method trait
(`latest_block`, `sync(from, to) -> Vec<SyncEvent>`) that the builder accepts via
`with_utxo_syncer(Arc<dyn UtxoSyncer>)`. It ships two implementations, one over
Subsquid GraphQL and one over `eth_getLogs`; a third over this stream needs no
changes on kohaku's side beyond implementing that trait.

| this stream | Subsquid entity | kohaku `SyncEvent` |
|---|---|---|
| `Shield` (both variants) | `ShieldCommitment` | `Shield` |
| `Transact` | `TransactCommitment` | `Transact` |
| `GeneratedCommitmentBatch` | `LegacyGeneratedCommitment` | `Legacy` |
| `CommitmentBatch` | `LegacyEncryptedCommitment` | `Legacy` |
| `Nullified` / `Nullifiers` | `Nullifier` | `Nullified` |
| `Unshield` | `Unshield` | — (not consumed) |
| manifest `lastCoveredBlock()` | `transactions(orderBy: blockNumber_DESC, limit: 1)` | `latest_block()` |

The squid's `hash` on a `ShieldCommitment` is a convenience — kohaku's
`Shield::hash()` already falls back to Poseidon over the preimage when it is
absent, which is the path a log-backed syncer takes.

## 5. Operations (TXID / POI) — a separate stream

`boundParamsHash`, `utxoTreeIn`, `utxoTreeOut`, `utxoBatchStartPositionOut` and
the per-transaction grouping of nullifiers and commitments **cannot be derived
from logs**. They exist only in `transact()` calldata. Kohaku needs them only
under `with_poi()`, which is off by default.

They are published as their own stream, **`railgun-1-ops-subsquid`**, one record
per operation:

```json
{"entity":"railgun-operation","blockNumber":"0x189ad7b","transactionIndex":"0x29","opIndex":"0x0",
 "nullifiers":["0x…"],"commitments":["0x…"],"boundParamsHash":"0x…",
 "utxoTreeIn":"0x3","utxoTreeOut":"0x3","utxoBatchStartPositionOut":"0xf167"}
```

These are **entity records**, not logs (SPEC §3.4) — they carry an `entity` field
and sort by `(blockNumber, transactionIndex, opIndex)` rather than
`(blockNumber, logIndex)`. A stream never mixes the two kinds, so
`railgun-1-smartwallet` is all logs and `railgun-1-ops-subsquid` is all
operations. Map them onto kohaku's `OperationsQuery` field for field; the ordering
triple is chronological, which is what `txid_indexer` requires when appending to
the TXID tree.

**Read the provenance before you trust it.** This stream is **mirrored from the
RAILGUN Subsquid index**, not derived from chain data — `protocolMetadata.source`
says so. Everything else we publish is reproducible from the chain; this is
reproducible only against that third-party index. It is a convenience (one
transport, one verification path, CDN-backed) and not an independent source of
truth. Kohaku validates TXID roots against the POI node before trusting proofs,
which is what actually backstops it.

The stream key names the provenance deliberately. A future
`railgun-1-ops` — same record format, derived from calldata — will take the
unqualified key; see `plans/RAILGUN_OPS_CALLDATA_PLAN.md`.

## 6. What neither stream carries

Not carried: the squid's `Token`, `VerificationHash`, and
`CommitmentBatchEventNew` entities (indexer normalization and bookkeeping — kohaku
queries none of them), and Railgun on chains other than mainnet.

## 7. Verifying the streams

`packages/producer/scripts/railgun-crosscheck.mjs` decodes the published stream
the way a consumer would and asserts the resulting commitment / nullifier /
unshield sets are identical to the RAILGUN Subsquid index for the same range:

```bash
node packages/producer/scripts/railgun-crosscheck.mjs \
  --manifest https://storage.googleapis.com/pp-state/ \
  --protocol railgun-1-smartwallet \
  --from 14693013 --to 16077369
```

It verifies each chunk's sha256 against the manifest, refuses to run if the
configured topic set and its own ABI table disagree, and reports differences per
commitment kind — so a whole-class outage (which is what a stale event signature
looks like) is obvious rather than buried in a total. Exits non-zero on any
difference.

For the operations stream, add `--ops` (which skips the log-topic gate). `--manifest`
also accepts a local directory, so a stream can be checked before publishing:

```bash
node packages/producer/scripts/railgun-crosscheck.mjs --ops \
  --manifest ./chunks --protocol railgun-1-ops-subsquid \
  --from 25800000 --to 25830000
```

Note what that proves and what it does not: because the stream mirrors the squid,
a match confirms our normalization and chunking are lossless — **not** that the
underlying data is correct. Only an independent derivation can show that.
