# Privacy Protocol State Distribution -- Specification

**Status:** Draft
**Version:** 0.1.0

## 1. Overview

Privacy protocols on Ethereum and its L2s require clients to process on-chain events to reconstruct local state (e.g., note sets, nullifier trees). Fetching these events directly from RPC nodes is slow, expensive, and impractical for browser-based or mobile clients.

This specification defines a system for distributing pre-scraped protocol state as static files served over a CDN:

- A **scraper** monitors on-chain events, batches them into **chunks**, and uploads them alongside a **manifest** (index file).
- A **client library** downloads chunks, validates them, and hands the data to the application for protocol-specific state reconstruction.

### Goals

- **Protocol-agnostic scraping.** The scraper treats events as opaque data. Protocol-specific logic lives in the client.
- **Static hosting.** The manifest and all chunks are plain files. Any CDN, S3 bucket, or static file server can host them.
- **Verifiable integrity.** Clients validate chunks against digests in the manifest. Protocol-specific verification (e.g., merkle tree reconstruction) is delegated to the application.
- **Simplicity over real-time.** Update frequency is typically hours to days. This is not a streaming protocol.

### Non-goals

- Real-time event streaming.
- Consensus or decentralized scraping (though nothing prevents multiple independent scrapers).
- Protocol-specific state derivation (that is the application's job).

## 2. Terminology

| Term | Definition |
|------|-----------|
| **Protocol instance** | A specific deployment of a privacy protocol, identified by the tuple `(protocol, chainId, instanceId)`. For example, Tornado Cash's 1 ETH pool on mainnet. |
| **Chunk** | A file containing a contiguous range of events for a protocol instance. |
| **Sealed chunk** | A chunk covering blocks that are considered final. Immutable once written. |
| **Hot head** | The most recent chunk for a protocol instance. Mutable -- it grows as new events are scraped and may be rewritten. At most one hot head exists per protocol instance at any time. |
| **Manifest** | A JSON file (the index) listing all available chunks and their metadata. The single entry point for clients. |
| **Reorg safety buffer** | A per-chain block count. The scraper only settles chunks for blocks at least this deep. |

## 3. Data Formats

All numeric values are hex-encoded with a `0x` prefix. All files are JSON. Compressed files use gzip (see Section 7).

### 3.1 Manifest

The manifest is the entry point. A client fetches it to discover which chunks are available.

```json
{
    "version": 1,
    "updatedAt": "2024-01-15T12:00:00.000Z",
    "compression": "gzip",
    "availableProtocols": {
        "${protocol}-${chainId}-${instanceId}": {
            "protocol": "tornado-cash",
            "protocolMetadata": { "denomination": "100000000000000000" },
            "chainId": "0x1",
            "trackedAddresses": ["0x12d66f87a04a9e220743712ce6d9bb1b5616b8fc"],
            "trackedEventTopics": [
                "0xa945e51eec50ab98c161376f0db4cf2aeba3ec92755fe2fcd388bdbbb80ff196",
                "0xe9e508bad6d4c3227e881ca19068f099da81b5164dd6d62b2eaf1e8bc6c34931"
            ],
            "chunks": [
                {
                    "fromBlock": "0x0",
                    "toBlock": "0x100",
                    "file": "${protocol}-${chainId}-${instanceId}-[0x0,0x100).jsonl.gz",
                    "size": "0x4f2",
                    "digest": { "type": "sha256", "data": "0xabcdef..." }
                }
            ],
            "hotHead": {
                "fromBlock": "0x100",
                "toBlock": "0x1a0",
                "file": "${protocol}-${chainId}-${instanceId}-[0x100,0x1a0).hot.jsonl.gz",
                "size": "0x2c1",
                "digest": { "type": "sha256", "data": "0xabcdef..." }
            }
        }
    }
}
```

Each stream key maps to one entry holding its descriptive metadata plus its chunk pointers. A chunk's mutability is encoded by **which field it lives in** — `chunks` (sealed, immutable) vs `hotHead` (the mutable trailing chunk) — not by a per-chunk flag. A consumer derives a stream's first/last covered block from its chunk ranges.

**Fields:**

| Field | Description |
|-------|-------------|
| `version` | Integer manifest format version (currently `1`). The format is still in development: the field is informational — a client reads the `availableProtocols` shape and re-stamps the current version on write rather than gating on the number. |
| `updatedAt` | ISO 8601 timestamp, refreshed on every manifest write. |
| `compression` | Compression codec applied to chunk files. `"gzip"` today. |
| `availableProtocols` | Map of stream key → its entry (metadata + chunks). Keys are serialized sorted, so the bytes are independent of write order. |
| `…{}.protocol` | Protocol family name (e.g. `"tornado-cash"`, `"privacy-pools"`, `"railgun"`). Optional. |
| `…{}.protocolMetadata` | Free-form, protocol-specific metadata copied verbatim from the producer config — a blank slate (e.g. Tornado `denomination`, Privacy Pools `asset`). Optional. **Its keys MUST be treated as immutable per stream** (see below). |
| `…{}.chainId` | The chain the stream is scraped from, `0x`-hex. Optional. |
| `…{}.trackedAddresses` | The unique contract addresses whose events the stream collects. Optional. |
| `…{}.trackedEventTopics` | The unique event `topic0`s (event-signature hashes) the stream collects. Optional. Lets a consumer filter a stream by event type. |
| `…{}.chunks` | Ordered array of the stream's **sealed** (immutable) chunk descriptors. |
| `…{}.hotHead` | The stream's single **hot head** descriptor (the mutable trailing chunk). Optional; absent when there is no in-progress tail. |
| `…chunk.fromBlock` | First block in the chunk's range (inclusive). |
| `…chunk.toBlock` | End of the chunk's range (exclusive). The chunk contains events from blocks `[fromBlock, toBlock)`. |
| `…chunk.file` | Filename of the chunk, relative to the manifest's base URL. |
| `…chunk.size` | Size in bytes of the chunk file as **stored (compressed)**, `0x`-hex. |
| `…chunk.digest` | Integrity digest of the **uncompressed** chunk content: `{ "type": "sha256", "data": "0x<hex>" }`. |

**`protocolMetadata` immutability:** the keys under `protocolMetadata` describe the entire stream — including chunks already published — so they MUST NOT change for a given stream key once set. The producer writes them **once** (when the stream first appears) and never overwrites them, so editing them in config after the fact has **no effect** on the manifest. To change a stream's metadata semantics, publish under a **new stream key** instead.

**Invariants:**

- There is at most one hot head per stream (`…{}.hotHead` is a single object, not an array).
- Within `…{}.chunks`, sealed chunks are sorted by `fromBlock` ascending and are contiguous: for consecutive chunks A and B, `A.toBlock == B.fromBlock`.
- The hot head continues the sealed chain: `hotHead.fromBlock` equals the last sealed chunk's `toBlock` (or the stream's start block if nothing has sealed yet).

### 3.2 Chunk

A chunk holds the events for a single protocol instance over a contiguous block range. Sealed chunks and hot heads share the same format. The file is **JSONL** (newline-delimited JSON) — one event object per line — gzip-compressed on disk. There is **no envelope object**: the instance key and block range live in the manifest and in the filename, not inside the chunk.

```
{"contractAddress":"0x...","eventTopic":"0x...","topics":["0x...","0x..."],"data":"0x...","blockNumber":"0x1","logIndex":"0x1"}
{"contractAddress":"0x...","eventTopic":"0x...","topics":["0x...","0x..."],"data":"0x...","blockNumber":"0x2","logIndex":"0x0"}
```

**Per-event fields** (all lowercase `0x`-hex):

| Field | Description |
|-------|-------------|
| `contractAddress` | Emitting contract. |
| `eventTopic` | The event signature topic (`= topics[0]`); chunks group/filter by it. |
| `topics` | Full log `topics` array; indexed event args live in `topics[1..]`. |
| `data` | ABI-encoded non-indexed event data (log `data` field). Opaque to the spec -- protocol-specific. |
| `blockNumber` | Block in which the event was emitted. |
| `logIndex` | Log index within the block. |

Each line is self-describing (it carries its own `contractAddress`/`eventTopic`) rather than being nested under grouping keys. An empty chunk — a scanned range with no matching events — is a zero-byte payload, which still asserts "this range was scanned."

**Ordering:** events MUST be globally sorted by `(blockNumber, logIndex)` ascending. This ordering is deterministic and affects the chunk digest -- a differently-ordered chunk with the same events produces a different digest and fails validation.

**Note on hashes:** the format intentionally omits `transactionHash` and `blockHash` to minimize chunk size. These hashes are incompressible and add significant bloat. The reorg safety buffer (Section 6) ensures sealed chunks only contain finalized events, eliminating the need for block hash verification. They are also not recoverable from the chunk alone, but neither is needed for state reconstruction; protocol-specific validation (e.g., merkle tree reconstruction) provides integrity guarantees beyond what these hashes would offer.

### 3.3 Canonical Form (Normalization)

Chunks are content-addressed: a chunk's identity is the SHA-256 of its bytes (§7.2). For two scrapers to agree on a digest, the bytes must be produced deterministically. A conforming chunk MUST observe all of the following.

1. **Field set and order.** Each event object contains exactly the six fields of §3.2, serialized in this order: `contractAddress`, `eventTopic`, `topics`, `data`, `blockNumber`, `logIndex`. No other keys. `eventTopic` MUST equal `topics[0]`.
2. **Hex casing.** Every hex value is lowercase and `0x`-prefixed. Byte strings (`contractAddress` = 20 bytes, each `topics` entry = 32 bytes, `data` = arbitrary length) are emitted verbatim. The quantities `blockNumber` and `logIndex` are minimal hex — no leading zeros (e.g. `0x0`, `0x1a2b`).
3. **JSON encoding.** Each event is encoded as compact JSON with no insignificant whitespace (no spaces after `:` or `,`), and `topics` is a JSON array in log order.
4. **Line framing (JSONL).** One event per line, each line — including the last — terminated by a single `\n` (`U+000A`). An empty chunk (a scanned range with no matching events) is a **zero-byte** payload.
5. **Ordering.** Events are globally sorted by `(blockNumber, logIndex)` ascending across the whole chunk — not grouped by contract or topic.
6. **Digest.** The digest (§7.2) is computed over these **uncompressed** JSONL bytes. gzip is transport only and never enters the digest, so compression level/implementation may vary freely.

Because every byte is pinned, identical inputs (the same logs from the chain) plus identical configuration (`fromBlock`, `chunkSettings`) yield byte-identical chunks and therefore identical digests. See §10 for what this enables.

## 4. Naming Conventions

### 4.1 Protocol Instance Key

Format: `${protocol}-${chainId}-${instanceId}`

Examples:
- `tornadocash-1-eth1` (Tornado Cash, Ethereum mainnet, 1 ETH pool)
- `railgun-42161-main` (Railgun, Arbitrum, main instance)

The key is an opaque string to this spec. Protocols define their own naming conventions for `instanceId`.

### 4.2 Chunk Filename

Format: `${protocolInstanceKey}-[${fromBlock},${toBlock}).jsonl` (or `.jsonl.gz` when gzip-compressed; the hot head adds a `.hot` infix: `…).hot.jsonl.gz`).

The half-open interval `[from, to)` is embedded in the filename for human readability and debuggability. The manifest is the authoritative source for block ranges, not the filename.

### 4.3 Block Range Convention

All block ranges use half-open intervals: `[fromBlock, toBlock)`.

- `fromBlock` is **inclusive** -- events at this block are included.
- `toBlock` is **exclusive** -- events at this block are NOT included.

This ensures clean composition: chunk N's `toBlock` equals chunk N+1's `fromBlock`, with no overlap or gaps.

## 5. Client Sync Protocol

The client library is a thin layer responsible for downloading, validating, and surfacing chunk data. It does NOT reconstruct protocol state -- that is the application's responsibility.

### 5.1 Sync Flow

1. **Fetch the manifest** from the known base URL.
2. **Diff against local state.** Compare locally stored chunks (by digest) against the manifest's chunk list. Determine which chunks need to be downloaded.
3. **Download missing sealed chunks.** These are immutable and can be cached indefinitely.
4. **Download (or re-download) the hot head.** The hot head may have changed since the last sync. Always re-fetch it.
5. **Validate each downloaded chunk:**
   - Decompress if needed.
   - Compute SHA-256 digest over the uncompressed content.
   - Compare against the manifest's `digest` field. Reject on mismatch.
   - Verify event ordering within the chunk: strictly ascending by `(blockNumber, logIndex)`.
   - Verify every event's `blockNumber` falls within the chunk's `[fromBlock, toBlock)` range from the manifest.
6. **Hand validated event data to the application** for protocol-specific state reconstruction.

### 5.2 What the Client Does NOT Do

- **Bridge the gap between the hot head and the current chain head.** The hot head's `toBlock` may lag behind the chain. Fetching recent events beyond the hot head is the application's responsibility (e.g., via direct RPC calls).
- **Protocol-specific validation.** Merkle tree reconstruction, nullifier set building, etc. are application concerns. The client validates chunk integrity (digest, ordering), not semantic correctness.
- **Partial sync from an arbitrary block.** Privacy protocol verification typically requires processing all events from `fromBlock` to reconstruct state. A client MAY support resuming from a known-good state if the application provides one, but that is an application-level concern.

### 5.3 Caching

- Sealed chunks are immutable. Once validated, they SHOULD be cached and never re-downloaded (matched by digest).
- The hot head MUST be re-fetched on every sync, since it may have grown or been rewritten.
- The manifest MUST be re-fetched on every sync. Standard HTTP caching headers (`ETag`, `Last-Modified`, `Cache-Control`) SHOULD be used for efficient polling.

## 6. Scraper Behavior

### 6.1 Event Collection

The scraper monitors configured contract addresses and event topics on-chain. It fetches events via standard RPC calls (`eth_getLogs`) and stores them in chunks.

The scraper is protocol-agnostic: it does not interpret event data. It stores the raw log `data` field exactly as returned by the RPC node.

### 6.2 Reorg Safety Buffer

Each chain has a configured `reorgSafetyBuffer` -- a number of blocks. The scraper MUST NOT scrape events from blocks newer than `chainHead - reorgSafetyBuffer`. This means all data in both sealed and hot heads is behind the safety buffer, and no chunk ever needs to be rewritten due to a reorg.

Recommended buffer values:

| Chain | Buffer | Rationale |
|-------|--------|-----------|
| Ethereum L1 | 128 blocks (~26 min) | 2x Casper FFG finality epoch. Reorgs beyond 1-2 blocks are extremely rare post-Merge. |
| Arbitrum / Optimism | 40 blocks | Sequencer-ordered; reorgs are near-impossible under normal operation. |

Since the scraper applies the buffer at scrape time, the distinction between sealed and hot heads is purely about mutability (the hot head grows on subsequent scrapes), not about reorg risk.

### 6.3 Chunk Lifecycle

1. **Scrape** events up to `chainHead - reorgSafetyBuffer`. Append them to the hot head.
2. When the hot head exceeds the configured threshold (max file size or max block range), **seal** it: the hot head becomes a sealed chunk, and a new empty hot head begins.
3. **Upload** the new or updated chunk files.
4. **Update** the manifest.

### 6.4 Upload Ordering

When publishing new data, the scraper MUST follow this order:

1. Upload all new chunk files.
2. Verify uploads are accessible (optional but recommended).
3. Upload the updated manifest.

This prevents clients from encountering a manifest that references chunks that don't exist yet. The manifest is the atomic commit point -- once it's updated, the new state is live.

If the scraper crashes between steps 1 and 3, orphaned chunk files may exist. These are harmless (unreferenced) and can be cleaned up periodically.

## 7. Compression and Integrity

### 7.1 Compression

Chunk files SHOULD be compressed with gzip for storage and transfer efficiency. The `compression` field in the manifest declares the algorithm.

| Value | Meaning |
|-------|---------|
| `"gzip"` | Chunks are gzip-compressed. File extension: `.jsonl.gz`. |
| `"none"` | Chunks are stored uncompressed. File extension: `.jsonl`. |

Gzip is chosen for broad compatibility: native browser support (`DecompressionStream`), universal CDN support, and availability in every runtime.

The manifest itself is NOT compressed under this spec (it's expected to be small). CDNs may apply transparent compression via `Content-Encoding`, which is orthogonal.

### 7.2 Integrity Digests

Digests are computed over the **uncompressed** JSON content. This ensures that:

- Different compression levels or implementations produce the same digest.
- Clients can validate after decompression, regardless of transport.

Format: a `{ "type": "sha256", "data": "0x<hex>" }` object (lowercase `0x`-prefixed hex), so the digest algorithm is explicit and future algorithms slot in without a string-parsing convention.

SHA-256 is chosen for universal support (Web Crypto API `SubtleCrypto.digest()`, Node.js `crypto`, every language's standard library) and sufficient collision resistance.

## 8. Scraper Configuration

A config describes *what* to scrape and how to chunk it. *Where* chunks are published and *how often* the scraper runs are deployment concerns, supplied out-of-band (see below), not per protocol.

```json
{
    "protocols": {
        "${protocol}-${chainId}-${instanceId}": {
            "chainId": "0x1",
            "fromBlock": "0x...",
            "reorgSafetyBuffer": "0x80",
            "chunkSettings": {
                "maxSizeBytes": "0x100000"
            },
            "events": [
                {
                    "contractAddress": "0x...",
                    "eventTopic": "0x...",
                    "filter": ["0x..."]
                }
            ]
        }
    }
}
```

**Fields:**

| Field | Description |
|-------|-------------|
| `chainId` | Chain ID for this protocol instance. |
| `fromBlock` | First block to scrape from. Protocol-defined. |
| `reorgSafetyBuffer` | Number of blocks to stay behind the chain head when sealing chunks. |
| `chunkSettings.maxSizeBytes` | Maximum uncompressed chunk size (bytes, number or `0x`-hex) before the hot head is sealed. |
| `events` | List of contract addresses and event topics to monitor. |
| `events[].filter` | Optional indexed parameter filter (topic1, topic2, etc.). |

**Deployment concerns (out of scope for the config).** All protocols in a config publish into a single store under one shared manifest, so the **store target** is a per-run choice, not a per-protocol one — the reference implementation takes it on the CLI (a local directory or a `gs://bucket/prefix` target). The **schedule** is likewise external (cron, a cloud scheduler, etc.); the scraper itself is a single-shot batch. Other implementations may wire these up however they like.

## 9. Manifest Signing

The manifest is the trust root: clients rely on it to discover chunks and their expected digests. If the CDN or hosting layer is compromised, an attacker could serve a modified manifest pointing to tampered chunks (which would pass digest checks, since the digests themselves live in the manifest). A signature lets a client trust a *public key* rather than the host or URL.

### 9.1 Scheme (implemented)

- **Algorithm: Ed25519** (raw 32-byte keys). Isomorphic across Node and browsers, and consistent with the SHA-256 digests used elsewhere — no extra primitives.
- **Detached signature.** Computed over the exact `index.json` bytes and published alongside it as **`index.json.sig`** — a single `0x`-hex string, like every other hash/key in the system. Signing the manifest transitively authenticates every chunk, since each chunk's digest is in the manifest; there are no per-chunk signatures.
- **Producer** signs unconditionally whenever a signing key is configured (`MANIFEST_SIGNING_KEY`, a `0x`-hex Ed25519 secret). The signature is rewritten on every manifest update. With no key configured the manifest is simply unsigned (still digest-verifiable).
- **Consumer** verifies only when a public key is configured (e.g. `--public-key <hex>` in the reference client). When enabled, verification is **mandatory** and runs over the raw bytes *before* parsing: a missing `.sig` or a mismatch is a hard error. With no public key configured the consumer skips signature checks (chunk digests are still enforced).

`index.json` and `index.json.sig` are two separate objects, not written atomically; a consumer that fetches a mismatched pair mid-publish fails verification and should retry.

### 9.2 Open topics (future work)

Signing authenticates the *publisher*, not data correctness (reproducibility + on-chain key anchoring cover that). Still open:

- **Key distribution.** How a client learns which public key(s) to trust — planned to be anchored in an on-chain registry, which only changes *where* the consumer reads the key, not the verification above.
- **Key rotation / revocation.** Updating keys without breaking existing clients.
- **Multi-signer.** Whether multiple independent scrapers can co-sign one manifest for stronger guarantees.

## 10. Reproducibility

Chunk digests are deterministic given identical inputs and configuration. Two scrapers producing chunks for the same protocol instance will produce identical digests if and only if:

1. They use the same RPC data source (or equivalent -- same events returned).
2. They use the same scraper configuration (`fromBlock`, `chunkSettings`, `reorgSafetyBuffer`).
3. They apply the canonical chunk form defined in §3.3 (fixed field set and order, lowercase minimal `0x`-hex, compact JSONL, global `(blockNumber, logIndex)` ordering, digest over the uncompressed bytes).

All three are achievable in practice — the serialization is fully pinned (no sorted-keys/whitespace ambiguity), so identical inputs and configuration yield byte-identical chunks and digests.

This is a **property**, not a **requirement**: the spec does not mandate multi-scraper consensus. A client trusts one manifest source. Independent verification is possible by running a scraper with identical configuration and comparing digests.

## 11. Open Questions

- **Chunk size guidance.** What are good default max sizes? This depends on the protocol's event volume and client memory constraints. Needs benchmarking.
