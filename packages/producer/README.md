# @saga-sync/producer

The producer side of **saga-sync** — the reference implementation of
[privacy-protocol-state-distribution](../../README.md). It scrapes a privacy
protocol's on-chain events, packages them into immutable compressed chunks with
integrity digests, and publishes an `index.json` manifest that any number of
[`@saga-sync/client`](../client) consumers can download and verify.

Three stages, each **both a standalone CLI and an importable library**:

```
  RPC ──▶ scraper ──NDJSON──▶ chunk-builder ──▶ Store (disk | gs://…)
              ▲                     ▲                     │ index.json + *.jsonl.gz
              └──────── orchestrator (cron entry) ────────┘
```

- **scraper** — connects to an Ethereum JSON-RPC, fetches event logs for a
  protocol over a block range, normalizes them, emits them as NDJSON.
- **chunk-builder** — consumes that NDJSON, partitions it into size-bounded
  immutable chunks (gzip + sha256), and maintains the append-only manifest. The
  trailing partial chunk is kept as a mutable **hot head**.
- **orchestrator** — the cron entry point. Loops every protocol in the config,
  runs `scrape → chunk` for each **in-process** in block-range batches, and owns
  the hot-head lifecycle. This is the normal path; the two lower CLIs are for
  backfills, debugging, or composing by hand.

Depends on [`@saga-sync/core`](../core) (schema, crypto, `Store`), `viem` (RPC),
`zod` (config validation), and optionally `@google-cloud/storage` (lazy-loaded,
only for `gs://` targets).

## Install & build

```bash
pnpm install
pnpm build          # tsc -b, builds core first
```

The examples below run the built JS from the repo root (`packages/producer/dist/…`).

---

## Orchestrator CLI — the normal path

Loads every protocol from the config, computes each one's next-from-block from the
manifest (sealed chunks + mutable hot head), and loops `scrape → chunk` in
**batches** of `--batch-size` blocks (default 100K). Within a tick protocols run
sequentially, a lockfile prevents overlapping runs, and the trailing partial after
each batch is persisted as the protocol's **hot head** — subsequent ticks fold new
events into it until it reaches the size limit and is promoted into the immutable
list.

```bash
node packages/producer/dist/orchestrator/cli.js \
  --config ./example-config.json \
  --rpc https://ethereum-rpc.publicnode.com \
  --output-dir ./chunks
```

stderr summary on a cold start with a forced-promotion size limit:

```
orchestrator: tornado-cash-1-eth-0.1 ran 3 batch(es), sealed 14 chunk(s) + hot head [0x17f76ce, 0x17f7803)
orchestrator: 1 ran, 0 skipped, 0 failed [tip 0x17f7802]
```

What gets created:

```
./chunks/
  tornado-cash-1-eth-0.1-[0x17f7000,0x17f71f3).jsonl.gz      # immutable sealed chunks
  ...
  tornado-cash-1-eth-0.1-[0x17f76ce,0x17f7803).hot.jsonl.gz  # mutable hot head (one per protocol)
  index.json
  .orchestrator.lock                                          # only present during a run
```

Re-running with no chain advance is a no-op: the start block is derived from
`max(hotHead.toBlock, lastSealed.toBlock)` and the protocol is skipped when
there's nothing new. The previous hot-head file is deleted after the manifest is
updated (its URL changes each time the range advances, so every URL stays
immutable and CDN-cacheable).

### Cron entry (daily)

One entry handles every protocol; a still-running tick makes the next exit quietly
via the lockfile.

```
0 2 * * * cd /path/to/repo && node packages/producer/dist/orchestrator/cli.js \
  --config ./example-config.json --rpc https://ethereum-rpc.publicnode.com \
  --output-dir ./chunks >> /var/log/orchestrator.log 2>&1
```

For the cloud deployment (Cloud Run Job + Cloud Scheduler + Cloud CDN) see the
repo-root [DEPLOY.md](../../DEPLOY.md).

### Flags

```
--config <path>        required   config JSON (all protocols)
--rpc <url>            required   Ethereum JSON-RPC URL (one chain per run)
--output-dir <path>    required   chunks + index.json directory, or gs://bucket[/prefix]
--lock-dir <path>      optional   directory for .orchestrator.lock (default = output-dir)
--protocol-id <id>     optional   restrict to one protocol (backfills / reruns)
--batch-size <n>       optional   blocks per batch (default 100000)
--concurrency <n>      optional   protocols scraped in parallel (default 4)
--confirmations <n>    optional   fallback reorg buffer (default 12)
--window <n>           optional   scraper window (default 2000)
--size-limit <n>       optional   chunk cap if config has none (default 10 MiB)
--dry-run              optional   report what would run, touch nothing
```

- **`--protocol-id`** still derives the from-block from the manifest, so it
  catches one protocol up to tip without affecting the others.
- **`--batch-size`** bounds the crash blast radius (in-flight events lost on crash
  ≤ one batch); larger batches reduce hot-head rewrite overhead during cold-start
  backfills. Daily steady-state usually fits in one batch.
- **Chunk size** comes from each protocol's `chunkSettings.maxSizeBytes` in the
  config, falling back to `--size-limit`.
- **`--dry-run`** prints per-protocol ranges without acquiring the lockfile — safe
  alongside a live cron.

### Exit codes

- `0` — clean run (zero or more protocols ran, or another orchestrator held the lock)
- `1` — config error, missing flags, or unknown `--protocol-id`
- `2` — at least one protocol threw mid-run (others may still have succeeded)

---

## Scraper CLI

Pure "input range → output events": connects to an RPC, fetches + normalizes logs,
writes NDJSON to **stdout** and a one-line summary to **stderr**. Writes no chunks
or manifest.

```bash
node packages/producer/dist/scraper/cli.js \
  --config ./example-config.json \
  --protocol-id tornado-cash-1-eth-0.1 \
  --rpc https://ethereum-rpc.publicnode.com \
  --from-block 0xC50101 --to-block 0xC50200 \
  --dry-run
# → NDJSON on stdout; stderr:
# scraper: 2 event(s) for tornado-cash-1-eth-0.1 [0xc50101, 0xc50200] (dry-run: cursor not updated)
```

Useful variations:

```bash
# Persist a cursor (drop --dry-run) — next run with no --from-block resumes from cursor+1
node .../scraper/cli.js --config ./example-config.json --protocol-id tornado-cash-1-eth-0.1 \
  --rpc <url> --from-block 0xC50000 --to-block 0xC50100
cat cursor.json   # → { "tornado-cash-1-eth-0.1": { "lastScrapedBlock": "0xc50100" } }

# Scrape up to the chain's finalized block (omit --to-block)
node .../scraper/cli.js --config ./example-config.json --protocol-id tornado-cash-1-eth-0.1 \
  --rpc <url> --from-block 0xC50101 --dry-run

# Inspect with jq
node .../scraper/cli.js ... --dry-run | jq -c '{block: .blockNumber, topic: .eventTopic}'
```

### Flags

```
--config <path>        required   config JSON
--protocol-id <id>     required   protocol key to scrape
--rpc <url>            required   Ethereum JSON-RPC URL
--from-block <hex>     optional   override cursor / config fromBlock
--to-block <hex>       optional   override the resolved finalized block
--confirmations <n>    optional   fallback reorg buffer (default 12)
--window <n>           optional   blocks per eth_getLogs call (default 2000)
--cursor-dir <path>    optional   directory for cursor.json (default = config dir)
--dry-run              optional   do not persist the cursor
```

Exit 0 on success, 1 on error.

---

## Chunk-builder CLI

Reads `CanonicalEvent` NDJSON on **stdin** (scraper output), partitions the scanned
range into immutable `.jsonl.gz` chunks, and appends to a local `index.json`.

```bash
node packages/producer/dist/scraper/cli.js --config ./example-config.json \
  --protocol-id tornado-cash-1-eth-0.1 --rpc <url> \
  --from-block 0xC50101 --to-block 0xC50200 --dry-run \
| node packages/producer/dist/chunk-builder/cli.js \
    --protocol-id tornado-cash-1-eth-0.1 \
    --from-block 0xC50101 --to-block 0xC50201 \
    --output-dir ./chunks
```

**Mind the upper bound.** The scraper's `--to-block` is **inclusive**
(`[from, to]`); the chunk-builder's is **exclusive** (`[from, to)`). To cover the
same range, pass `scraper.to_block + 1` to the chunk-builder.

The standalone CLI always **seals** the trailing partial (no hot heads — that path
is orchestrator-only). An empty range still emits one zero-byte chunk covering the
full `[from, to)`, so the manifest asserts the range was scanned.

```bash
# Force multiple chunks with a small size limit
node .../scraper/cli.js ... | node .../chunk-builder/cli.js \
  --protocol-id tornado-cash-1-eth-0.1 --from-block 0xC50000 --to-block 0xC50501 \
  --output-dir ./chunks --size-limit 800

# Inspect a chunk
gunzip -c './chunks/tornado-cash-1-eth-0.1-[0xc50101,0xc50201).jsonl.gz' | jq -c .
```

### Flags

```
--protocol-id <id>     required   manifest key + filename prefix
--from-block <hex>     required   inclusive start of the scanned range
--to-block <hex>       required   exclusive end of the scanned range
--output-dir <path>    required   chunks + index.json directory
--size-limit <n>       optional   max uncompressed bytes per chunk (default 10 MiB)
--dry-run              optional   compute metadata, write nothing
```

---

## Module internals

**`scraper/`** — pure "range → events"; writes no chunks or manifest.

- **`config.ts`** — reads the config JSON, zod-validates **only** the fields the
  pipeline uses. `loadConfig(path, id)` returns one `ScraperTarget`;
  `loadAllProtocols(path)` returns all. Validated: `chainId`, `fromBlock`,
  `events[]`; optional `chunkSettings.maxSizeBytes`, `protocol`, `protocolMetadata`.
  Derives `trackedAddresses`/`trackedEventTopics` from the unique
  `events[].contractAddress`/`.eventTopic` in first-seen order.
- **`normalize.ts`** — `normalize(rpcLog)` → `CanonicalEvent`: lowercases every hex
  field, sets `eventTopic = topics[0]`, keeps the full `topics` array (indexed args
  like commitments/nullifiers), rejects pending logs, and drops only
  `transactionHash`/`blockHash`.
- **`scrape.ts`** — `scrape(client, opts)`, an async generator yielding raw RPC
  logs. Slices `[fromBlock, toBlock]` into `window`-sized sub-ranges, issuing one
  `eth_getLogs` per event filter; on a range/result-size error it **halves the
  window and retries**. Each window is fully buffered and sorted by
  `(blockNumber, logIndex)` before any log is yielded, so a retry never double-emits.
- **`cursor.ts`** — `Cursor` over a `Store`, recording `lastScrapedBlock` per
  protocol. **Only** the standalone scraper CLI uses it; the orchestrator derives
  resume points from the manifest.
- **`cli.ts`** — the scraper entry point. Also exports `finalizedBlock(client)`
  and `assertChainId(client, expected)`, reused by the orchestrator.

**`chunk-builder/`** — `CanonicalEvent` NDJSON → chunk files + drives core's `Manifest`.

- **`accumulator.ts`** — `ChunkAccumulator`, a **pure** block-aligned partition
  state machine. Buffers the in-progress block separately and commits it only once
  the next block arrives — a chunk boundary always falls *between* blocks (a
  multi-event block is never split). `add(event)` returns a completed chunk on a
  size boundary; `finish()` returns the trailing accumulator.
- **`archive.ts`** — `ChunkArchive` over a `Store`. `seal()` / `writeHotHead()`
  build the JSONL, compute the sha256 of the **uncompressed** bytes, gzip, and
  `put` under a range-derived filename. `readEvents()` is the inverse.
  `buildJsonl()` is exported (the client's integration tests use it as a fixture
  builder).
- **`cli.ts`** — `processStream(lines, args)` drives the accumulator: optional seed
  events (a prior hot head) → stream events, sealing each completed chunk → the
  trailing accumulator, either **sealed** (`trailingMode: "seal"`, standalone
  default) or **returned** (`trailingMode: "suspend"`, the orchestrator's hot-head
  carry-over).

**`orchestrator/`** — the cron entry point; composes the other two in-process.

- **`pipeline.ts`** — `runProtocolOnce(opts)` builds the scrape → normalize →
  NDJSON generator and hands it to `processStream`. No subprocess, no stdio: errors
  propagate as plain exceptions.
- **`cli.ts`** — per tick: acquire the lockfile, load config + manifest, query the
  chain tip, then for each protocol run `processProtocol` (resolve start block,
  load any prior hot head, loop `[start, tip]` in `--batch-size` steps, persist the
  final trailing accumulator as the new hot head). Also exports `acquireLock(path)`.

**`storage/`** — the producer-only stores + the factory.

- **`GcsStore`** — write-side, backed by a GCS bucket (optional `prefix`). GCS
  writes are atomic + strongly consistent (no temp-file+rename). Sets per-key
  `Content-Type` + `Cache-Control` (sealed chunks immutable/long-lived; `index.json`
  / hot head short TTL). The `@google-cloud/storage` SDK is lazy-loaded behind an
  injectable provider, so the module compiles + unit-tests without the dependency.
- **`DryRunStore`** — decorates another `Store`; `put`/`delete` become no-ops,
  `get`/`list` pass through. How `--dry-run` is implemented without every other
  class knowing about it.
- **`createStore(cfg)`** / **`parseStoreTarget(target)`** — the factory mapping
  `disk`→core's `DiskStore`, `http`→core's `HttpStore`, `gcs`→`GcsStore`
  (`s3`/`ftp` throw until added); a `gs://bucket[/prefix]` `--output-dir` selects
  `GcsStore`, anything else is a local disk path.

**`keygen.ts`** — CLI that mints an Ed25519 manifest-signing keypair (over core's
`signing`). Set `MANIFEST_SIGNING_KEY` (a 32-byte hex seed) on the orchestrator /
chunk-builder to publish a signed `index.json.sig`; consumers pin the matching
public key via the client's `--public-key`.

---

## Data formats

### Config JSON (`--config`)

*What* to scrape, not *where/when*. The store target is a per-run CLI argument and
the schedule is external — all protocols in one config share one store + manifest.

```json
{
  "protocols": {
    "tornado-cash-1-eth-0.1": {
      "chainId": "0x1",
      "fromBlock": "0x8b1d26",
      "chunkSettings": { "maxSizeBytes": 10485760 },
      "protocol": "tornado-cash",
      "protocolMetadata": { "denomination": "100000000000000000", "asset": "ETH" },
      "events": [
        { "contractAddress": "0x12d66f87…", "eventTopic": "0xa945e51e…" },
        { "contractAddress": "0x12d66f87…", "eventTopic": "0xe9e508ba…",
          "filter": ["0x000…indexed-arg-match"] }
      ]
    }
  }
}
```

| Field | Required | Meaning |
|---|---|---|
| `chainId` | yes | `0x`-hex chain id; verified against the RPC at startup |
| `fromBlock` | yes | contract deploy block; the cold-start scrape origin |
| `events[]` | yes | one entry per `(contractAddress, eventTopic)` to scrape |
| `events[].filter` | no | extra indexed-topic matchers appended after `eventTopic` |
| `chunkSettings.maxSizeBytes` | no | per-protocol chunk cap (number or `0x`-hex) |
| `protocol` | no | family name copied into the manifest (e.g. `tornado-cash`) |
| `protocolMetadata` | no | free-form passthrough; **immutable per stream** once first published |

The protocol key `${protocol}-${chainId}-${instanceId}` is treated as an opaque id
(chain identity comes from the explicit `chainId`, since the key itself isn't
safely parseable — protocol names contain hyphens).

### NDJSON (scraper stdout → chunk-builder stdin)

One `CanonicalEvent` per line, all-lowercase `0x`-hex, globally ordered by
`(blockNumber, logIndex)`:

```json
{"contractAddress":"0x12d6…","eventTopic":"0xa945…","topics":["0xa945…","0x1e8f…"],"data":"0x…","blockNumber":"0xc501f5","logIndex":"0x68"}
```

### Chunk file `${protocolId}-[${fromBlock},${toBlock}).jsonl.gz`

Gzip-compressed JSONL of the NDJSON above, for the block range in the filename.
Immutable once written. An empty chunk is a zero-byte payload. The **hot-head file**
(`…hot.jsonl.gz`) is byte-identical in format — the only differences are the `.hot.`
infix and that the manifest tracks it in the entry's `hotHead` field, not `chunks`.
At most one hot head per protocol.

### Manifest `index.json`

Format **v1** — see the root [SPEC.md §3.1](../../SPEC.md) for the normative schema
and the root [README.md](../../README.md) for the protocol-level walkthrough. The
`Manifest` class that reads/writes it lives in [`@saga-sync/core`](../core).
`digest.data` is the sha256 of the **uncompressed** JSONL (`gunzip -c <file> |
shasum -a 256`); `size` is the compressed byte length. With a signing key set, a
sibling `index.json.sig` holds a detached Ed25519 signature over the exact bytes.

### State files

- **`cursor.json`** — the standalone scraper's resume pointer
  (`{ "<id>": { "lastScrapedBlock": "0x…" } }`). The orchestrator does not use it.
- **`.orchestrator.lock`** — plain text pid, created `O_EXCL` at tick start, removed
  on exit; a stale lock (dead pid) is reclaimed automatically.

---

## Invariants a replica must honor

These are what make two independent scrapers produce byte-identical chunks (see
[SPEC.md](../../SPEC.md) for the normative statements):

1. **Windowed `eth_getLogs` with adaptive split** — slice the range; on a
   "range too large" / "too many results" error, halve the window and retry.
   Buffer + sort each window before yielding.
2. **Normalization keeps the whole log** — lowercase all hex; `eventTopic` =
   `topics[0]`; keep `topics[1..]`; drop only `transactionHash`/`blockHash`.
3. **Block-aligned chunking** — a chunk covers a half-open `[from, to)`; boundaries
   fall between blocks, so all events of a block land in exactly one chunk.
4. **Size-bounded sealing** — seal when accumulated **uncompressed** bytes would
   exceed the limit; the digest is sha256 of that uncompressed JSONL; `size` in the
   manifest is the **compressed** count.
5. **Hot heads** — the trailing partial is written mutable (`*.hot.jsonl.gz`,
   tracked in the entry's `hotHead`). The next run loads it, appends, re-writes; on
   crossing the size limit it is **promoted** (overflow sealed, fresh hot head holds
   the remainder).
6. **Batching** — process `[start, tip]` in `--batch-size` steps; each batch's
   trailing accumulator seeds the next. The manifest advances only on a completed
   seal, so a re-run is idempotent (`(blockNumber, logIndex)` is the dedup key).
7. **Reorg safety** — `toBlock` defaults to the chain's own **finalized** block;
   fallback for RPCs without the tag is `head − confirmations` (default 12).
8. **Start-block resolution** — `hotHead.toBlock` → last sealed chunk's `toBlock` →
   `config.fromBlock` (first run only). The manifest self-bootstraps after the first
   chunk.
9. **Range-derived, immutable URLs** — every chunk/hot-head file is named
   `${protocolId}-[${fromBlock},${toBlock})…`, so a URL's bytes never change. When a
   hot head advances, a new file is written and the old one deleted; only the
   manifest pointer is mutable.
10. **Single-writer lock** — the orchestrator holds `.orchestrator.lock` (`O_EXCL` +
    pid, stale-pid recovery). A second instance exits quietly.

### Block-range conventions

- The **scraper** works in **inclusive** ranges `[fromBlock, toBlock]` (what
  `eth_getLogs` takes).
- **Chunks and the manifest** use **half-open** ranges `[fromBlock, toBlock)`, so
  consecutive chunks compose with no gap or overlap.
- The orchestrator bridges them: a scraper batch over inclusive `[X, Y]` becomes a
  chunk-builder range of half-open `[X, Y+1)`.

Invariant: a protocol's sealed chunks + its hot head partition
`[firstSealed.fromBlock, hotHead.toBlock)` contiguously.

---

## Publishing to Google Cloud Storage

Publishing to GCS is entirely a `Store`-seam concern — the scrape/chunk logic, the
manifest/chunk format, and the client are all unchanged. Point `--output-dir` at a
bucket; consumers read the same objects over plain HTTP.

- **Producer write** — `--output-dir gs://bucket[/prefix]` routes through
  `parseStoreTarget` → `GcsStore`, writing chunks + `index.json` with per-object
  `Cache-Control` (sealed chunks `max-age=31536000, immutable`; `index.json` / hot
  head `max-age=30`).
- **Consumer read** — point the client's manifest URL at a CDN in front of the
  bucket, or at the bucket directly. `HttpStore` does plain GETs; nothing in the
  client changes.

Operational notes: the lockfile is filesystem-only — for a `gs://` target it
defaults to the cwd (`--lock-dir` to override), and in a stateless container
single-execution scheduling is the real single-writer guard. Hot-head objects
orphan as their range advances; a GCS Object Lifecycle rule (delete
`*.hot.jsonl.gz` after N days) cleans them up. The bucket is public-read —
integrity comes from the sha256 digests, not access control.

The full cloud runbook (Cloud Run Job, Cloud Scheduler, Secret Manager, Cloud CDN)
is in the repo-root **[DEPLOY.md](../../DEPLOY.md)**.
