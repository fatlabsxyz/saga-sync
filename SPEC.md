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
| **Settled chunk** | A chunk covering blocks that are considered final. Immutable once written. |
| **Hot chunk** | The most recent chunk for a protocol instance. Mutable -- it grows as new events are scraped and may be rewritten. At most one hot chunk exists per protocol instance at any time. |
| **Manifest** | A JSON file (the index) listing all available chunks and their metadata. The single entry point for clients. |
| **Reorg safety buffer** | A per-chain block count. The scraper only settles chunks for blocks at least this deep. |

## 3. Data Formats

All numeric values are hex-encoded with a `0x` prefix. All files are JSON. Compressed files use gzip (see Section 7).

### 3.1 Manifest

The manifest is the entry point. A client fetches it to discover which chunks are available.

```json
{
    "version": 1,
    "updatedAt": "2024-01-15T12:00:00Z",
    "compression": "gzip",
    "availableStates": {
        "${protocol}-${chainId}-${instanceId}": {
            "startBlock": "0x0",
            "updatedAtBlock": "0x...",
            "chunks": [
                {
                    "fromBlock": "0x0",
                    "toBlock": "0x100",
                    "file": "${protocol}-${chainId}-${instanceId}-[0x0,0x100).json.gz",
                    "size": "0x...",
                    "settled": true,
                    "digest": "sha256:abcdef..."
                },
                {
                    "fromBlock": "0x100",
                    "toBlock": "0x1a0",
                    "file": "${protocol}-${chainId}-${instanceId}-[0x100,0x1a0).json.gz",
                    "size": "0x...",
                    "settled": false,
                    "digest": "sha256:abcdef..."
                }
            ]
        }
    }
}
```

**Fields:**

| Field | Description |
|-------|-------------|
| `version` | Integer. Manifest format version. Currently `1`. |
| `updatedAt` | ISO 8601 timestamp of when this manifest was generated. |
| `compression` | Compression algorithm applied to chunk files. `"gzip"` or `"none"`. |
| `availableStates` | Map of protocol instance keys to their chunk lists. |
| `startBlock` | The first block relevant to this protocol instance (protocol-defined, not necessarily block 0). |
| `updatedAtBlock` | The chain block height up to which this protocol instance has been scraped. Per-instance because different instances may be on different chains or scrape schedules. |
| `chunks` | Ordered array of chunk descriptors. MUST be sorted by `fromBlock` ascending. |
| `chunks[].fromBlock` | First block in the chunk's range (inclusive). |
| `chunks[].toBlock` | End of the chunk's range (exclusive). The chunk contains events from blocks `[fromBlock, toBlock)`. |
| `chunks[].file` | Filename of the chunk, relative to the manifest's base URL. |
| `chunks[].size` | Size in bytes of the chunk file as stored (after compression, if any). |
| `chunks[].settled` | Boolean. `true` if this chunk is immutable. `false` for the hot chunk. |
| `chunks[].digest` | Integrity digest of the **uncompressed** chunk content. Format: `algorithm:hex_digest`. |

**Invariants:**

- There is at most one chunk with `settled: false` per protocol instance, and it MUST be the last entry.
- Chunks MUST be contiguous: for consecutive chunks A and B, `A.toBlock == B.fromBlock`.
- `chunks[0].fromBlock == startBlock`.

### 3.2 Chunk

A chunk contains events for a single protocol instance over a contiguous block range. Settled and hot chunks share the same format.

```json
{
    "protocolInstance": "${protocol}-${chainId}-${instanceId}",
    "fromBlock": "0x0",
    "toBlock": "0x100",
    "events": {
        "${contractAddress}": {
            "${eventTopic}": [
                {
                    "data": "0x...",
                    "blockNumber": "0x1",
                    "logIndex": "0x1"
                }
            ]
        }
    }
}
```

**Fields:**

| Field | Description |
|-------|-------------|
| `protocolInstance` | The protocol instance key this chunk belongs to. |
| `fromBlock` | Same as in the manifest. |
| `toBlock` | Same as in the manifest. |
| `events` | Events grouped by contract address, then by event topic. |
| `events[][].data` | The ABI-encoded event data (log `data` field). Opaque to the spec -- protocol-specific. |
| `events[][].blockNumber` | Block in which the event was emitted. |
| `events[][].logIndex` | Log index within the block. |

**Ordering:** Within each `(contractAddress, eventTopic)` group, events MUST be sorted by `(blockNumber, logIndex)` ascending. This ordering is deterministic and affects the chunk digest -- a differently-ordered chunk with the same events will produce a different digest and fail validation.

**Note on hashes:** The format intentionally omits `txHash` and `blockHash` to minimize chunk size. These hashes are incompressible and add significant bloat. The reorg safety buffer (Section 6) ensures settled chunks only contain finalized events, eliminating the need for block hash verification. Protocol-specific validation (e.g., merkle tree reconstruction) provides integrity guarantees beyond what tx hashes would offer.

## 4. Naming Conventions

### 4.1 Protocol Instance Key

Format: `${protocol}-${chainId}-${instanceId}`

Examples:
- `tornadocash-1-eth1` (Tornado Cash, Ethereum mainnet, 1 ETH pool)
- `railgun-42161-main` (Railgun, Arbitrum, main instance)

The key is an opaque string to this spec. Protocols define their own naming conventions for `instanceId`.

### 4.2 Chunk Filename

Format: `${protocolInstanceKey}-[${fromBlock},${toBlock}).json` (or `.json.gz` when compressed).

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
3. **Download missing settled chunks.** These are immutable and can be cached indefinitely.
4. **Download (or re-download) the hot chunk.** The hot chunk may have changed since the last sync. Always re-fetch it.
5. **Validate each downloaded chunk:**
   - Decompress if needed.
   - Compute SHA-256 digest over the uncompressed content.
   - Compare against the manifest's `digest` field. Reject on mismatch.
   - Verify event ordering within the chunk: `(blockNumber, logIndex)` ascending per group.
   - Verify `fromBlock`/`toBlock` consistency with the manifest.
6. **Hand validated event data to the application** for protocol-specific state reconstruction.

### 5.2 What the Client Does NOT Do

- **Bridge the gap between the hot chunk and the current chain head.** The hot chunk's `toBlock` may lag behind the chain. Fetching recent events beyond the hot chunk is the application's responsibility (e.g., via direct RPC calls).
- **Protocol-specific validation.** Merkle tree reconstruction, nullifier set building, etc. are application concerns. The client validates chunk integrity (digest, ordering), not semantic correctness.
- **Partial sync from an arbitrary block.** Privacy protocol verification typically requires processing all events from `startBlock` to reconstruct state. A client MAY support resuming from a known-good state if the application provides one, but that is an application-level concern.

### 5.3 Caching

- Settled chunks are immutable. Once validated, they SHOULD be cached and never re-downloaded (matched by digest).
- The hot chunk MUST be re-fetched on every sync, since it may have grown or been rewritten.
- The manifest MUST be re-fetched on every sync. Standard HTTP caching headers (`ETag`, `Last-Modified`, `Cache-Control`) SHOULD be used for efficient polling.

## 6. Scraper Behavior

### 6.1 Event Collection

The scraper monitors configured contract addresses and event topics on-chain. It fetches events via standard RPC calls (`eth_getLogs`) and stores them in chunks.

The scraper is protocol-agnostic: it does not interpret event data. It stores the raw log `data` field exactly as returned by the RPC node.

### 6.2 Reorg Safety Buffer

Each chain has a configured `reorgSafetyBuffer` -- a number of blocks. The scraper MUST NOT scrape events from blocks newer than `chainHead - reorgSafetyBuffer`. This means all data in both settled and hot chunks is behind the safety buffer, and no chunk ever needs to be rewritten due to a reorg.

Recommended buffer values:

| Chain | Buffer | Rationale |
|-------|--------|-----------|
| Ethereum L1 | 128 blocks (~26 min) | 2x Casper FFG finality epoch. Reorgs beyond 1-2 blocks are extremely rare post-Merge. |
| Arbitrum / Optimism | 40 blocks | Sequencer-ordered; reorgs are near-impossible under normal operation. |

Since the scraper applies the buffer at scrape time, the distinction between settled and hot chunks is purely about mutability (the hot chunk grows on subsequent scrapes), not about reorg risk.

### 6.3 Chunk Lifecycle

1. **Scrape** events up to `chainHead - reorgSafetyBuffer`. Append them to the hot chunk.
2. When the hot chunk exceeds the configured threshold (max file size or max block range), **seal** it: the hot chunk becomes a settled chunk, and a new empty hot chunk begins.
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
| `"gzip"` | Chunks are gzip-compressed. File extension: `.json.gz`. |
| `"none"` | Chunks are stored uncompressed. File extension: `.json`. |

Gzip is chosen for broad compatibility: native browser support (`DecompressionStream`), universal CDN support, and availability in every runtime.

The manifest itself is NOT compressed under this spec (it's expected to be small). CDNs may apply transparent compression via `Content-Encoding`, which is orthogonal.

### 7.2 Integrity Digests

Digests are computed over the **uncompressed** JSON content. This ensures that:

- Different compression levels or implementations produce the same digest.
- Clients can validate after decompression, regardless of transport.

Format: `sha256:<hex_digest>` (lowercase hex, no `0x` prefix on the hash itself).

SHA-256 is chosen for universal support (Web Crypto API `SubtleCrypto.digest()`, Node.js `crypto`, every language's standard library) and sufficient collision resistance.

## 8. Scraper Configuration

```json
{
    "protocols": {
        "${protocol}-${chainId}-${instanceId}": {
            "chainId": "0x1",
            "startBlock": "0x...",
            "reorgSafetyBuffer": "0x80",
            "cronString": "0 0 * * *",
            "chunkSettings": {
                "criteria": "size",
                "maxSizeBytes": "0x100000"
            },
            "storeSettings": {
                "baseUrl": "https://cdn.example.com/state/",
                "fileNameTemplate": "${protocol}-${chainId}-${instanceId}-[${fromBlock},${toBlock}).json.gz",
                "backend": "s3",
                "backendSettings": {
                    "bucket": "state-chunks",
                    "region": "us-east-1"
                }
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
| `startBlock` | First block to scrape from. Protocol-defined. |
| `reorgSafetyBuffer` | Number of blocks to stay behind the chain head when settling chunks. |
| `cronString` | Scrape schedule in cron format. |
| `chunkSettings.criteria` | When to seal the hot chunk. `"size"` (max file size) or `"blocks"` (max block range). |
| `chunkSettings.maxSizeBytes` | (If criteria is `"size"`.) Maximum uncompressed chunk size before sealing. |
| `chunkSettings.maxBlockRange` | (If criteria is `"blocks"`.) Maximum block range per chunk before sealing. |
| `storeSettings.baseUrl` | Public URL prefix where clients will fetch the manifest and chunks. |
| `storeSettings.fileNameTemplate` | Filename pattern for chunks. |
| `storeSettings.backend` | Storage backend: `"s3"`, `"ftp"`, `"disk"`, etc. |
| `storeSettings.backendSettings` | Backend-specific configuration. |
| `events` | List of contract addresses and event topics to monitor. |
| `events[].filter` | Optional indexed parameter filter (topic1, topic2, etc.). |

## 9. Manifest Signing (WIP)

The manifest is the trust root: clients rely on it to discover chunks and their expected digests. If the CDN or hosting layer is compromised, an attacker could serve a modified manifest pointing to tampered chunks (which would pass digest checks since the digests themselves are in the manifest).

Manifest signing would allow clients to verify that the manifest was produced by a trusted scraper. This section is intentionally left incomplete for future work.

**Topics to address:**

- Signature format and algorithm (e.g., ECDSA with secp256k1 for Ethereum ecosystem familiarity, or Ed25519 for simplicity).
- Key distribution: how does a client learn which public key(s) to trust?
- Key rotation: how are keys updated without breaking existing clients?
- Multi-signer support: can multiple independent scrapers co-sign a manifest for stronger guarantees?
- Where the signature lives: a detached signature file, a field in the manifest, or an HTTP header.

## 10. Reproducibility

Chunk digests are deterministic given identical inputs and configuration. Two scrapers producing chunks for the same protocol instance will produce identical digests if and only if:

1. They use the same RPC data source (or equivalent -- same events returned).
2. They use the same scraper configuration (`startBlock`, `chunkSettings`, `reorgSafetyBuffer`).
3. They apply the same event ordering (`(blockNumber, logIndex)` ascending per group).
4. They produce the same JSON serialization (key ordering, whitespace).

Points 1-3 are achievable in practice. Point 4 requires the spec to define a canonical JSON serialization for chunks (to be specified -- likely sorted keys, no extra whitespace).

This is a **property**, not a **requirement**: the spec does not mandate multi-scraper consensus. A client trusts one manifest source. Independent verification is possible by running a scraper with identical configuration and comparing digests.

## 11. Open Questions

- **Chunk size guidance.** What are good default max sizes? This depends on the protocol's event volume and client memory constraints. Needs benchmarking.
- **Canonical JSON serialization.** To enable reproducibility, the spec should define exact JSON formatting for chunks (key order, whitespace, number formatting). Needs specifying.
