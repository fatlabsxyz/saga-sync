# SPEC.md vs. implementation — divergence digest

Comparison of the newly-added `SPEC.md` (Draft v0.1.0) against the current code
(the `saga-sync` workspace under `packages/`). Each item is tagged:

- **KEEP** — deliberate divergence we should keep; spec is the one that should bend.
- **AHEAD** — implementation is ahead of the spec; spec should catch up.
- **GAP** — spec asks for something we don't do; candidate to implement.
- **DOC** — pure naming/wording mismatch; reconcile in one of the two docs.

---

## 1. Chunk payload format — biggest divergence

| | SPEC §3.2 | Implementation (`archive.ts`, `normalize.ts`) |
|---|---|---|
| Container | one JSON **object** per chunk | **JSONL** — one event per line (`.jsonl.gz`) |
| Grouping | nested `events[contract][topic] = [...]` | flat: every line is a self-describing event |
| Envelope | chunk carries `protocolInstance`, `fromBlock`, `toBlock` | no envelope — ranges live only in the manifest + filename |
| Per-event fields | `data`, `blockNumber`, `logIndex` (lossy by design) | also `contractAddress`, `eventTopic`, `topics[]` (`transactionHash`/`blockHash` dropped — see below) |

- **JSONL vs single object → KEEP.** JSONL is what makes the mutable hot head
  append-cheap and lets the client stream/merge without parsing a whole object.
  This is load-bearing for the hot-head design; the spec's grouped object should
  be revised to JSONL.
- **Dropping `txHash`/`blockHash` → DONE (2026-06-11).** SPEC §3.2 deliberately
  omits them to shrink chunks ("incompressible bloat"). We now drop both in
  `normalize.ts` (kept `topics`, where indexed args live). Aligns with the spec's
  rationale; re-digests every chunk (fine in dev). `transactionHash` was the only
  field not recoverable offline (same-tx grouping) — accepted, since no targeted
  protocol's reconstruction needs tx-atomicity.
- **No in-chunk envelope → KEEP.** There's no per-chunk `fromBlock`/`toBlock` to
  cross-check, but the client now validates events against the **manifest's**
  range instead (`verifyChunkEvents`), satisfying §5.5's intent.

## 2. Manifest shape

| | SPEC §3.1 | Implementation (`chunk-builder/manifest.ts`) |
|---|---|---|
| Top-level meta | `version`, `updatedAt`, `compression` | **none** |
| Per-instance | object `{startBlock, updatedAtBlock, chunks[]}` | bare array: `availableStates[key]: ChunkMeta[]` |
| Hot chunk | a chunk with `settled:false`, last in `chunks[]` | separate `hotHeads[key]: ChunkMeta` map; sealed entries have **no** `settled` field |
| Digest | string `"sha256:abcdef"` (algo:hex, no `0x`) | object `{type:"sha256", data:"0x…"}` |
| Digest scope | uncompressed content | uncompressed content ✓ aligned |

- **`version` → RESOLVED.** `version: 1` is stamped on every write. While the
  format is in development the reader treats it as informational (no reject-newer
  gate yet) — see the "Manifest versioning collapsed to `1`" note below.
- **`updatedAt` → GAP (cheap).** ISO timestamp; trivial to add on `persist()`.
  Useful for "is this stale?" without parsing chunks. (We already expose
  `lastCoveredBlock`; `updatedAtBlock` per instance is the block-height analog.)
- **`compression` field → GAP (cheap) / KEEP behavior.** gzip is hardcoded; the
  field is absent. Adding `"compression":"gzip"` documents reality for free even
  if we never implement `"none"`.
- **`availableStates[key]` array vs object → RESOLVED (2026-07-02).**
  The shape is now a per-stream **object** `availableProtocols[key] = { protocol,
  protocolMetadata, chainId, trackedAddresses, trackedEventTopics, chunks[],
  hotHead? }`, which matches the spec's per-instance-object direction. SPEC §3.1 was
  rewritten to this shape (both updated together). The mutable tail lives in each
  entry's `hotHead` field. `protocolMetadata` is a config-carried passthrough whose
  keys are **immutable per stream** (written once, never overwritten).
  `startBlock`/`updatedAtBlock` are still *derived*
  (`firstCoveredBlock`/`lastCoveredBlock`), not stored.
- **Manifest versioning collapsed to `1` (2026-07-03).** While the format is in
  development there is a single version — `MANIFEST_VERSION = 1`, the
  `availableProtocols` shape. The interim renumbering (an earlier draft briefly
  stamped `2` alongside a since-removed `availableStates`/`hotHeads` migration) was
  reverted: the reader no longer gates on the version integer or migrates an old
  layout — it reads `availableProtocols` and re-stamps `1` on write, so any manifest
  carrying an older development stamp is transparently rewritten. Re-introduce a real
  version bump + reject-newer gate when the format is frozen for release.
- **Manifest write path (2026-07-02).** Writes are **coalesced + throttled** to
  ≤~1/sec and serialized (mutations update memory + a `flush()` guarantees
  durability at end of run), and `availableProtocols` keys are serialized sorted —
  both to stay under GCS's ~1-write/sec/object limit and to keep bytes
  order-independent under parallel scraping. `GcsStore.put` also retries 429s.
- **Digest encoding → DOC.** `sha256:hex` vs `{type,data:0x…}` is the same
  information. Our `{type}` object is more extensible; reconcile wording.

## 3. Naming / terminology — DOC

| SPEC | Implementation |
|---|---|
| **settled** chunk | **sealed** chunk |
| **hot** chunk | **hot head** |
| `startBlock` (config + manifest) | `fromBlock` |
| `(protocol, chainId, instanceId)` tuple | opaque `protocolId` string |

All semantic no-ops. `sealed`/`hot head` are nicer than `settled`/`hot chunk`;
recommend the spec adopt our terms. `startBlock`→`fromBlock` already flagged as a
cheap rename in prior notes — still unresolved, still cheap.

## 4. Scraper config (SPEC §8)

| Field | SPEC | Implementation (`config.ts`) |
|---|---|---|
| start | `startBlock` | `fromBlock` |
| reorg | `reorgSafetyBuffer` (per chain) | **absent** — uses chain `finalized` tag, `--confirmations 12` fallback |
| seal criteria | `criteria: "size"\|"blocks"`, `maxSizeBytes`/`maxBlockRange` | `chunkSettings.maxSizeBytes` (+ a loosely-validated `criteria`/`criteriaSettings`) |
| store | `storeSettings.{baseUrl, backend, backendSettings}` | `storeSettings.{protocol, protocolSettings}`, no `baseUrl` |
| filter | `events[].filter` | `events[].filter` ✓ supported |

- **`reorgSafetyBuffer` → KEEP** (deliberate: we chose cryptoeconomic
  `finalized` over a fixed buffer; reorg-safe and invisible downstream).
- **`backend`/`backendSettings` vs `protocol`/`protocolSettings` → DOC.** Same
  concept; pick one set of names. (`baseUrl` we don't store; the client is given
  the manifest URL directly.)
- **`criteria` values `"blocks"` vs our `"block"` → DOC**, and our criteria field
  is essentially decorative today (only `maxSizeBytes` is enforced). Either wire
  up block-range sealing or drop the field from the spec.

## 5. Manifest signing — implementation is AHEAD

SPEC §9 is explicitly WIP. We've already shipped:

- **Ed25519 detached signature** → `index.json.sig` (resolves spec's "algorithm"
  and "where the signature lives" open topics).
- Producer signs from `MANIFEST_SIGNING_KEY`; consumer opt-in verifies via
  `--public-key`.

Still open in **both**: key distribution (on-chain registry planned), key
rotation, multi-signer co-signing. **Action: fold our design back into SPEC §9**
and demote it from WIP to "implemented (v1), these sub-topics remain open."

## 6. Client sync (SPEC §5)

Mostly aligned: fetch manifest every sync, cache sealed chunks by digest,
re-fetch hot every time, mandatory sha256 verify on every chunk (cache hits
included).

- **Event-ordering verification (§5.5) → DONE 2026-06-12.** The client now runs
  `verifyChunkEvents` on every chunk (after digest, before handing events up):
  strictly ascending `(blockNumber, logIndex)` + every block within the manifest
  range; violations throw `CanonicalFormError`. Belt-and-suspenders over the
  digest — defends against a correctly-digested but non-canonical producer.
  Validated against real mainnet chunks (8,840 events) with no false positive.

## 7. Reproducibility / canonical JSON — RESOLVED 2026-06-11

Previously a gap (the spec flagged canonical serialization as "to be specified").
Now pinned: **SPEC §3.3 Canonical Form** defines field set + order, lowercase
minimal `0x`-hex, compact JSONL line framing, global `(blockNumber, logIndex)`
ordering, and digest-over-uncompressed — matching what `normalize.ts` +
`scrape.ts` + `archive.ts` already produce. README has the summary version;
§10 references §3.3. Cross-scraper byte-for-byte reproducibility is now a
specified property, not just an in-practice accident.

---

## Changes we could implement — shortlist

Ordered by value/cost:

1. ~~**Drop `transactionHash` + `blockHash` from chunk events** (§1).~~ ✅ **Done
   2026-06-11** — removed from `CanonicalEvent`/`normalize.ts`; docs updated.
2. ~~**Add `version`, `updatedAt`, `compression` to the manifest** (§2).~~ ✅ **Done
   2026-06-11** — `MANIFEST_VERSION=1`; producer stamps all three on `persist()`;
   consumer enforces `version` (rejects higher) and surfaces version/`updatedAt`
   in `client info`.
3. ~~**Fold the shipped Ed25519 signing design into SPEC §9**.~~ ✅ **Done
   2026-06-11** — §9 rewritten (algorithm, detached `index.json.sig`, producer
   env-key / consumer opt-in verify); demoted from WIP, key
   distribution/rotation/multi-signer kept as open sub-topics.
4. ~~**Reconcile terminology + config field names** toward the code.~~ ✅ **Done
   2026-06-11** — SPEC.md updated to match the implementation:
   `settled`→`sealed`, `hot chunk`→`hot head`, `startBlock`→`fromBlock`,
   `backend/backendSettings`→`protocol/protocolSettings`, `criteria:"blocks"`→
   `"block"`. The entangled structural pieces were pulled in to keep the spec
   coherent: §3.1 manifest (`availableStates`/`hotHeads` split, no `settled`
   flag, `{type,data}` digest), §3.2 chunk (JSONL, no envelope), filename
   `.json`→`.jsonl`.
5. ~~**Canonical-JSON spec** (§7).~~ ✅ **Done 2026-06-11** — SPEC §3.3 Canonical Form.
6. ~~**Client-side ordering check** (§6).~~ ✅ **Done 2026-06-12** — `verifyChunkEvents`
   (range + strict `(blockNumber, logIndex)` ordering) on every fetched chunk.

All items 1–6 are done.

**Still divergent (deliberate, left in SPEC as written):** `reorgSafetyBuffer`
(SPEC §6/§8) vs. the implementation's chain `finalized` tag + `--confirmations`
fallback — both reorg-safe; not reconciled because it wasn't part of the
naming pass.
