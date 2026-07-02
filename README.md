# privacy-protocol-state-distribution (WIP)

This project aims to solve state distribution for privacy protocols in the least opinionated way. We provide a spec and a reasonable implementation, but other implementations are welcomed.

This README is a concise **protocol** overview — the data formats, naming, and the normalization rules that make chunks reproducible. For the full normative specification see [SPEC.md](SPEC.md); for the reference implementation (module layout, CLIs, algorithms) see [ARCHITECTURE.md](ARCHITECTURE.md).

## Index file
```json
{
    "version": 2,
    "updatedAt": "2026-06-11T14:00:00.000Z",
    "compression": "gzip",
    "availableProtocols": {
        "${protocol}-${chainId}-${instanceId}": {
            "protocol": "tornado-cash",
            "protocolMetadata": { "denomination": "100000000000000000" },
            "chainId": "0x1",
            "trackedAddresses": ["0x..."],
            "chunks": [{
                "fromBlock": "0x0",
                "toBlock": "0x123434235",
                "file": "${protocol}-${chainId}-${instanceId}-[${fromBlock},${toBlock}).jsonl.gz",
                "size": "0xBytes",
                "digest": { "type": "sha256", "data": "0x..." }
            }],
            "hotHead": {
                "fromBlock": "0x123434235",
                "toBlock": "0x123434500",
                "file": "${protocol}-${chainId}-${instanceId}-[${fromBlock},${toBlock}).hot.jsonl.gz",
                "size": "0xBytes",
                "digest": { "type": "sha256", "data": "0x..." }
            }
        }
    }
}
```

`version` is the manifest format version (currently `2`); a consumer rejects a manifest declaring a higher version rather than misparsing it. `updatedAt` is an ISO-8601 stamp refreshed on every write (a chunk-free freshness signal). `compression` declares the chunk codec (`gzip` today).

`availableProtocols[id]` maps a stream key to one entry: descriptive metadata (`protocol`, `protocolMetadata`, `chainId`, `trackedAddresses`) plus its chunk pointers. `chunks` holds **immutable** sealed chunks (cache forever; verified by their sha256 digest). `hotHead` holds at most one **mutable** entry — the trailing partial that has not yet reached the chunk size limit. Each hot-head rewrite produces a new file under a new range-derived URL (so any given URL is itself immutable and CDN-cacheable); only the manifest pointer changes. `hotHead` is absent when there is no in-progress tail. `protocolMetadata` is a free-form passthrough from config whose keys are **immutable per stream** (changing them is unsupported; publish a new stream key instead).

Together the sealed chunks and the hot head partition `[firstSealed.fromBlock, hotHead.toBlock)` with no gaps — each entry's `toBlock` equals the next entry's `fromBlock`.

## protocol state chunk

Each chunk file (sealed or hot) is JSONL + gzip — one normalized event per line:

```
{"contractAddress":"0x...","eventTopic":"0x...","topics":["0x...","0x..."],"data":"0x...","blockNumber":"0x1","logIndex":"0x1"}
{"contractAddress":"0x...","eventTopic":"0x...","topics":["0x...","0x..."],"data":"0x...","blockNumber":"0x2","logIndex":"0x0"}
```

The `digest.data` recorded in the manifest is the sha256 of the **uncompressed** JSONL bytes — verifiable by `gunzip <file> | sha256sum`. `contractAddress` and `eventTopic` are stored on every event rather than as outer grouping keys, so each line is self-describing. `transactionHash` and `blockHash` are intentionally not stored (incompressible, and unnecessary for state reconstruction given the reorg-safe scrape boundary).

## normalization & reproducibility

Chunks are **content-addressed**: a chunk's identity is the sha256 of its bytes. For two independent scrapers to agree on a digest, every step from raw log to bytes must be deterministic. The normalization rules:

- **Field set & order.** Each event is reduced to exactly these fields, in this order: `contractAddress`, `eventTopic`, `topics`, `data`, `blockNumber`, `logIndex`. `eventTopic` equals `topics[0]`. Nothing else is kept — notably no `transactionHash` or `blockHash`.
- **Lowercasing.** Every hex value — address, topics, data, and the `blockNumber`/`logIndex` quantities — is lowercased. Block quantities are minimal `0x`-hex (no leading zeros), as returned by the RPC.
- **Serialization.** One event per line as compact JSON (no insignificant whitespace), newline-separated, with a trailing newline (JSONL). A range scanned with no matching events is a **zero-byte** chunk.
- **Ordering.** Events are globally sorted by `(blockNumber, logIndex)` ascending across the whole chunk — not grouped by contract or topic. This is the single canonical order; any other order is a different (and therefore invalid) chunk.
- **Digest scope.** The digest covers the **uncompressed** JSONL. gzip is transport only and never enters the digest, so compression level/implementation can vary freely.

Given the same `fromBlock`, the same chunk boundaries (`chunkSettings.maxSizeBytes`), and the same set of logs from the chain, these rules make chunk bytes — and thus digests — **byte-identical** across scrapers. Reproducibility is a *property*, not a consensus requirement: a client trusts one manifest, and anyone can independently re-scrape and compare digests.

## scraper config

A config describes *what* to scrape and how to chunk it:

```json
{
    "protocols": {
        "${protocol}-${chainId}-${instanceId}": {
            "chainId": "0x...",
            "fromBlock": "0x...",
            "chunkSettings": {
                "maxSizeBytes": "0x..."
            },
            "events": [{
                "contractAddress": "0x...",
                "eventTopic": "0x...",
                "filter?": ["0x..."]
            }]
        }
    }
}
```

`chainId`, `fromBlock`, and `events` are required; `chunkSettings.maxSizeBytes` caps the uncompressed size at which the hot head is sealed into an immutable chunk. *Where* chunks are published and *how often* the scraper runs are deployment concerns, not config: all protocols in a config share one store and manifest, so the store target is a per-run CLI choice (a local directory or `gs://bucket/prefix`), and the schedule is external (cron / a cloud scheduler).
