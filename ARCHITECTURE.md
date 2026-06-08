# Architecture — privacy-protocol-state-distribution

Reference implementation of a pipeline that distributes the on-chain event
state of privacy protocols (Tornado Cash, Privacy Pools, Railgun, …) as
verifiable, independently-downloadable chunks.

The chain is the source of truth but it is expensive and slow to read in bulk.
This pipeline scrapes a protocol's events once, packages them into immutable
compressed chunks with integrity digests, and publishes an index — so any number
of clients can reconstruct the protocol's state by downloading static files and
verifying them, instead of each re-scraping the chain.

> This document describes the **reference implementation**. `README.md` holds the
> wire **spec** (the manifest / chunk / config JSON shapes). Other implementations
> that produce a spec-conforming manifest + chunks are equally valid.

---

## 1. The pipeline

A **producer** side (scrape → package → publish) and a **consumer** side
(download → verify → use) meet at one storage abstraction:

```
  PRODUCER                                                      CONSUMER
            ┌─────────┐  CanonicalEvent  ┌───────────────┐               ┌────────┐
  RPC  ───▶ │ scraper │ ─ NDJSON stream ▶│ chunk-builder │               │ client │ ─▶ app
            └─────────┘                  └───────────────┘               └────────┘
                  ▲                              ▲                            │
                  └───────────┬──────────────────┘                  fetch +  │
                       ┌──────────────┐                             verify    │
                       │ orchestrator │  cron entry point                     │
                       └──────────────┘                                       │
                              │ write                                   read  │
                        ┌─────────────────────────────────────────────────────┐
                        │                       Store                          │
                        │   disk (producer) · HTTP/CDN read-side (consumer)    │
                        └─────────────────────────────────────────────────────┘
```

- **scraper** — connects to an Ethereum JSON-RPC, fetches event logs for a
  protocol over a block range, normalizes them, emits them as NDJSON.
- **chunk-builder** — consumes that NDJSON, partitions it into size-bounded
  immutable chunks (gzip + sha256), and maintains an append-only `index.json`
  manifest. The trailing partial chunk is kept as a mutable **hot head**.
- **orchestrator** — the cron entry point. Loops over every protocol in the
  config and runs `scrape → chunk` for each, **in-process**, in block-range
  **batches**. Owns the hot-head lifecycle.
- **client** — the consumer. Reads the manifest, downloads a protocol's chunks +
  hot head, **verifies every chunk's sha256** against the manifest, and yields
  the merged `CanonicalEvent` stream to an application. Trusts the manifest URL,
  verifies everything under it.
- **storage** — a `Store` interface abstracting all object persistence.
  `DiskStore` (producer writes, local read) and `HttpStore` (consumer read-side
  over a CDN) exist today; the seam exists so S3 buckets can be added without
  touching anything else.

Each stage is **both a standalone CLI and an importable library**. The scraper
and chunk-builder can be run by hand and piped (`scraper | chunk-builder`); the
orchestrator and client import them as libraries and compose them with no
subprocesses.

---

## 2. Tech stack

- **Node ≥ 20**, **TypeScript** (strict, ESM, `module: Node16`).
- **Runtime dependencies** (3): `viem` (Ethereum RPC client), `zod` (config
  validation), `@noble/hashes` (sha256).
- **Optional dependency**: `@google-cloud/storage`, used only by `GcsStore` and
  lazy-loaded — disk/http runs and consumers never load it (see §4.1).
- **Dev dependencies**: `typescript`, `@types/node`, `tsx`, `vitest`.
- `package.json` scripts: `build` → `tsc`, `test` → `vitest run`,
  `typecheck` → `tsc --noEmit`, `dev` → `tsx`.
- `tsconfig.json`: `target ES2022`, `module/moduleResolution Node16`, `strict`,
  `rootDir src`, `outDir dist`, test files excluded from the build.
- No database, no message queue, no framework. State is plain files behind the
  `Store`.

---

## 3. Repository layout

```
src/
  storage/
    store.ts          Store interface — put / get / delete / list (all async)
    disk-store.ts     DiskStore: local FS, atomic write via temp-file + rename
    dry-run-store.ts  DryRunStore: decorator that no-ops writes, delegates reads
    http-store.ts     HttpStore: read-only fetch over a base URL (consumer side)
    gcs-store.ts      GcsStore: write to a GCS bucket (producer publish side)
    index.ts          createStore() factory + parseStoreTarget() + re-exports
  hash.ts             sha256Hex() — the one place the digest algorithm is named
  scraper/
    config.ts         load + zod-validate the config; loadConfig / loadAllProtocols
    normalize.ts      raw RPC log → CanonicalEvent
    scrape.ts         async generator: windowed eth_getLogs with adaptive split
    cursor.ts         Cursor class — standalone-scraper resume pointer
    cli.ts            scraper entry point; exports finalizedBlock, assertChainId
  chunk-builder/
    archive.ts        ChunkArchive class — encode/decode chunk files over a Store
    accumulator.ts    ChunkAccumulator class — block-aligned partition state machine
    manifest.ts       Manifest class + ChunkMeta type — the index.json
    cli.ts            chunk-builder entry point; exports processStream
  orchestrator/
    pipeline.ts       runProtocolOnce — composes scrape + chunk-builder in-process
    cli.ts            orchestrator entry point; lockfile, batch loop, hot-head lifecycle
  client/
    fetch.ts          decodeAndVerify + fetchChunkFrom — gunzip, verify, parse a chunk
    verify.ts         verifyDigest + DigestMismatchError — sha256 check against manifest
    manifest.ts       loadManifest + selectSealedChunks/selectHotHead range helpers
    client.ts         Client class — merged streamEvents over sealed chunks + hot head
    format.ts         humanBytes + table — CLI rendering helpers
    cli.ts            client entry point; protocols/info/head/chunks/stream subcommands
```

Every module has a sibling `*.test.ts` (vitest). ~141 unit tests; both the
producer pipeline and the client are also verified end-to-end against
locally-published state served over HTTP (and the producer against a live
mainnet RPC).

---

## 4. Modules in detail

### 4.1 storage/

`Store` is the one seam for persistence. Keys are flat object names; the
interface is async because S3/HTTP backends are inherently async.

```ts
interface Store {
  put(key: string, data: Buffer): Promise<void>;   // atomic — no partial reads
  get(key: string): Promise<Buffer | null>;        // null if absent
  delete(key: string): Promise<void>;              // no error if absent
  list(prefix: string): Promise<string[]>;         // keys under a prefix
}
```

- **`DiskStore`** — backed by a base directory. `put` writes `${file}.${pid}.tmp`
  then `rename`s over the target; the rename is atomic on a single filesystem,
  so a crash mid-write never leaves a partial object.
- **`DryRunStore`** — decorates another `Store`; `put`/`delete` become no-ops,
  `get`/`list` pass through. This is how `--dry-run` is implemented — every other
  class stays oblivious to dry-run.
- **`HttpStore`** — read-only, backed by a base URL: `get` fetches
  `${baseUrl}/${key}`, returning `null` on 404. `put`/`delete`/`list` throw (same
  throw-on-unsupported pattern `DryRunStore` uses for the inverse case). The
  consumer read-side; pairs with a CDN-fronted bucket.
- **`GcsStore`** — producer write-side, backed by a Google Cloud Storage bucket
  (optional `prefix`). GCS object writes are atomic + strongly consistent, so no
  temp-file+rename is needed. Sets `Content-Type` and `Cache-Control` per key
  (sealed chunks immutable + long-lived; `index.json` / hot head short TTL). The
  `@google-cloud/storage` SDK is lazy-loaded behind an injectable provider, so the
  module compiles + unit-tests without the dependency and no other path loads it.
- **`createStore(cfg)`** — maps `cfg.protocol` (`disk` | `s3` | `http` | `ftp` |
  `gcs`) to an implementation. `disk`, `http`, `gcs` exist; `s3` / `ftp` throw a
  clear error until their classes are added. If `cfg.dryRun` is set, the result is
  wrapped in `DryRunStore`.
- **`parseStoreTarget(target)`** — resolves a producer `--output-dir`: a
  `gs://bucket[/prefix]` target selects `GcsStore`, anything else is a local disk
  path. Shared by the orchestrator and chunk-builder CLIs.

### 4.2 scraper/

Pure "input range → output events". Does not write chunks or the manifest.

- **`config.ts`** — reads the config JSON, zod-validates **only** the fields the
  pipeline uses. `loadConfig(path, protocolId)` returns one `ScraperTarget`;
  `loadAllProtocols(path)` returns all of them. Validated: `chainId`,
  `fromBlock`, `events[]`. Optional: `chunkSettings.maxSizeBytes`. Other config
  keys (`cronString`, `storeSettings`, `chunkSettings.criteria`) pass through
  unvalidated — reserved for operators / future use.
- **`normalize.ts`** — `normalize(rpcLog)` → `CanonicalEvent`: lowercases every
  hex field, sets `eventTopic = topics[0]`, keeps the full `topics` array, and
  rejects pending logs (null block fields). Nothing is dropped — indexed event
  args (commitments, nullifiers) live in `topics[1..]`, so a lossy projection
  here would make the distributed state unable to rebuild a protocol's tree.
- **`scrape.ts`** — `scrape(client, opts)` is an async generator yielding raw RPC
  logs. It slices `[fromBlock, toBlock]` into `window`-sized sub-ranges and, per
  sub-range, issues a raw `eth_getLogs` request per event filter. On a
  range/result-size error it **halves the window and retries** that sub-range.
  Each window is fully buffered and sorted by `(blockNumber, logIndex)` before
  any log is yielded, so a retry never double-emits.
- **`cursor.ts`** — `Cursor` class over a `Store`. Records `lastScrapedBlock` per
  protocol. **Only used by direct scraper-CLI runs**; the orchestrator derives
  resume points from the manifest instead.
- **`cli.ts`** — the scraper entry point. Also exports two helpers reused by the
  orchestrator: `finalizedBlock(client)` (the chain's own finalized block, or
  `null` if unsupported) and `assertChainId(client, expected)` (fails fast on a
  misconfigured RPC).

### 4.3 chunk-builder/

Consumes `CanonicalEvent` NDJSON, produces chunk files + the manifest.

- **`accumulator.ts`** — `ChunkAccumulator`, a **pure** (no-I/O) block-aligned
  partition state machine. Events are fed in order; it buffers the in-progress
  block separately and only commits it once the next block arrives — guaranteeing
  a chunk boundary always falls *between* blocks (a multi-event block is never
  split). `add(event)` returns a completed chunk when a size boundary was
  crossed; `finish()` returns the trailing accumulator.
- **`archive.ts`** — `ChunkArchive` over a `Store`. `seal()` / `writeHotHead()`
  build the JSONL, compute the sha256 digest of the **uncompressed** bytes, gzip,
  and `put` under a range-derived filename. `readEvents()` is the inverse
  (`get` + gunzip + parse). `buildJsonl()` is exported for reuse.
- **`manifest.ts`** — `Manifest` class wrapping a `Store`. Holds `index.json` in
  memory; **every mutation persists atomically** (so a crash leaves the manifest
  consistent up to the last completed seal). Reads: `sealedChunks`, `hotHead`,
  `lastCoveredBlock`. Mutations: `appendChunk`, `setHotHead`, `clearHotHead`.
  Also defines `ChunkMeta` — the per-chunk record.
- **`cli.ts`** — `processStream(lines, args)` drives the accumulator: feed seed
  events (a prior hot head, optional) → feed stream events, sealing each
  completed chunk through `ChunkArchive` + `Manifest` → handle the trailing
  accumulator. The trailing is either **sealed** (`trailingMode: "seal"`, the
  standalone-CLI default) or **returned** (`trailingMode: "suspend"`, the
  orchestrator's hot-head carry-over path).

### 4.4 orchestrator/

The cron entry point. Composes the other two stages in-process.

- **`pipeline.ts`** — `runProtocolOnce(opts)` builds the scrape → normalize →
  NDJSON generator and hands it to `processStream`. No subprocess, no stdio
  piping: errors propagate as plain exceptions.
- **`cli.ts`** — the orchestrator. Per tick: acquire a lockfile, load the config
  and the manifest, query the chain tip, then for each protocol run
  `processProtocol` — which resolves the start block, loads any prior hot head,
  loops `[start, tip]` in `--batch-size` steps calling `runProtocolOnce`, and
  persists the final trailing accumulator as the new hot head. Also exports
  `acquireLock(path)`.

### 4.5 client/

The consumer. Given a manifest URL it reconstructs a protocol's event history by
downloading the static files and verifying them — no trust in the publisher
beyond the manifest itself. Reads through the same `Store` seam (`HttpStore`),
with an optional local cache `Store`.

- **`verify.ts`** — `verifyDigest(meta, bytes)` recomputes the sha256 of a
  chunk's uncompressed JSONL and compares it to the manifest entry. **Mandatory**
  on every chunk, cache hits included; mismatch throws `DigestMismatchError`.
- **`fetch.ts`** — `decodeAndVerify` (gunzip → verify → JSONL parse) and
  `fetchChunkFrom(store, meta)`. A missing file throws `ChunkNotFoundError`,
  distinct from a digest mismatch so callers can tell "absent" from "tampered".
- **`manifest.ts`** — `loadManifest(store)` (single fetch; throws if absent) plus
  pure `selectSealedChunks` / `selectHotHead` range-overlap helpers. Re-uses the
  producer-side `Manifest` class so the shape is defined once.
- **`client.ts`** — the `Client` class. `streamEvents(protocolId, {from,to})`
  yields the merged `CanonicalEvent` stream in block order: sealed chunks (fetched
  with a bounded-concurrency sliding window, yielded in submission order) then the
  hot head (re-fetched every call, never cached). Sealed chunks optionally cache
  to a local `Store` — safe because they are immutable and content-addressed, and
  re-verified on every read.
- **`cli.ts`** — `protocols` / `info` / `head` / `chunks` (manifest-only, no chunk
  downloads) and `stream` (the full download). See §8.

---

## 5. Key algorithms & invariants

A replica must get these right; everything else is plumbing.

1. **Windowed `eth_getLogs` with adaptive split.** No provider will return logs
   for millions of blocks in one call. Slice the range; on a "range too
   large" / "too many results" error, halve the window and retry. Buffer +
   sort each window before yielding.

2. **Normalization keeps the whole log.** Lowercase all hex; `eventTopic` =
   `topics[0]`; keep `topics[1..]` (indexed args). Drop nothing.

3. **Block-aligned chunking.** A chunk covers a half-open block range
   `[from, to)`. Boundaries fall between blocks — all events of a given block
   land in exactly one chunk, even if that single block exceeds the size limit.

4. **Size-bounded sealing.** A chunk is sealed when accumulated uncompressed
   bytes would exceed `size_limit`. The digest is **sha256 of the uncompressed
   JSONL**; the file is then gzip-compressed; `size` in the manifest is the
   **compressed** byte count.

5. **Hot heads.** The trailing partial — not yet at `size_limit` — is not sealed
   as immutable. It is written as a **mutable hot head** (`*.hot.jsonl.gz`,
   tracked in `manifest.hotHeads`). The next run loads it back, appends new
   events, and re-writes it. When it finally crosses `size_limit` it is
   **promoted**: the overflow is sealed as an immutable chunk and a fresh hot
   head holds the remainder. Net result: the same immutable chunk count as a
   single big run, plus one live tail clients can poll for fresh data.

6. **Batching.** The orchestrator processes `[start, tip]` in `--batch-size`
   block steps (default 100 000). Each batch's trailing accumulator carries into
   the next as the seed. Smaller batches bound the crash blast radius; the
   manifest only advances on a completed seal, so a re-run is idempotent
   (at-least-once delivery; `(blockNumber, logIndex)` is the dedup key).

7. **Reorg safety.** `toBlock` defaults to the chain's own **finalized** block —
   reorg-proof, no per-chain confirmations table. Fallback for RPCs that don't
   support the `finalized` tag: `head − confirmations` (default 12).

8. **Start-block resolution.** Where to resume scraping a protocol:
   `hotHead.toBlock` → else last sealed chunk's `toBlock` → else
   `config.fromBlock` (the contract deploy block; first run only). The manifest
   is self-bootstrapping after the first chunk.

9. **Atomic writes.** Every file write is temp-file + rename (in `DiskStore`).
   The manifest re-writes wholesale on each mutation.

10. **Range-derived, immutable URLs.** Every chunk and hot-head file is named
    `${protocolId}-[${fromBlock},${toBlock})...` — so a given URL's bytes never
    change (CDN-cacheable). When a hot head advances, a *new* file is written and
    the old one deleted; only the manifest pointer is mutable.

11. **Single-writer lock.** The orchestrator holds `.orchestrator.lock`
    (`O_EXCL` open + pid, with stale-pid recovery). A second instance exits
    quietly. This is a local primitive, deliberately **not** part of `Store`.

---

## 6. Block-range conventions

- The **scraper** works in **inclusive** ranges `[fromBlock, toBlock]` — that is
  what `eth_getLogs` takes.
- **Chunks and the manifest** use **half-open** ranges `[fromBlock, toBlock)` —
  so consecutive chunks compose with no gap or overlap: each entry's `toBlock`
  equals the next entry's `fromBlock`.
- The orchestrator bridges them: a scraper batch covering inclusive `[X, Y]`
  becomes a chunk-builder range of half-open `[X, Y+1)`.

Invariant: a protocol's sealed chunks + its hot head partition
`[firstSealed.fromBlock, hotHead.toBlock)` contiguously.

---

## 7. Data formats — every input & output

### 7.1 INPUT — scraper config JSON (`--config`)

Consumed by the producer tools (scraper / chunk-builder / orchestrator); the
client needs only a manifest URL, not the config. `example-config.json`:

```json
{
  "protocols": {
    "tornado-cash-1-eth-0.1": {
      "chainId": "0x1",
      "fromBlock": "0x8b1d26",
      "cronString": "*/5 * * * *",
      "chunkSettings": { "maxSizeBytes": 10485760 },
      "storeSettings": {
        "protocol": "disk",
        "protocolSettings": {}
      },
      "events": [
        {
          "contractAddress": "0x12d66f87a04a9e220743712ce6d9bb1b5616b8fc",
          "eventTopic": "0xa945e51eec50ab98c161376f0db4cf2aeba3ec92755fe2fcd388bdbbb80ff196"
        },
        {
          "contractAddress": "0x12d66f87a04a9e220743712ce6d9bb1b5616b8fc",
          "eventTopic": "0xe9e508bad6d4c3227e881ca19068f099da81b5164dd6d62b2eaf1e8bc6c34931",
          "filter": ["0x000000000000000000000000abc...indexed-arg-match"]
        }
      ]
    }
  }
}
```

Per-protocol fields:

| Field | Required | Meaning |
|---|---|---|
| `chainId` | yes | `0x`-hex chain id; verified against the RPC at startup |
| `fromBlock` | yes | contract deploy block; the cold-start scrape origin |
| `events[]` | yes | one entry per `(contractAddress, eventTopic)` to scrape |
| `events[].filter` | no | extra indexed-topic matchers appended after `eventTopic` |
| `chunkSettings.maxSizeBytes` | no | per-protocol chunk size cap (number or `0x`-hex); else the CLI `--size-limit` / 10 MiB default |
| `cronString`, `storeSettings`, `chunkSettings.criteria` | no | reserved; not interpreted by the current implementation |

The protocol key `${protocol}-${chainId}-${protocolInstanceId}` is treated as an
opaque id (chain identity comes from the explicit `chainId` field, since the key
itself is not safely parseable — protocol names contain hyphens).

### 7.2 INPUT — RPC endpoint (`--rpc`)

Not a file: an Ethereum JSON-RPC URL. The scraper uses `eth_getLogs`,
`eth_getBlockByNumber` (finalized tag), `eth_blockNumber`, `eth_chainId`.

### 7.3 INTERMEDIATE — scraper output / chunk-builder input (NDJSON)

The scraper writes one `CanonicalEvent` per line to **stdout** (a one-line
summary goes to **stderr**). This is also the chunk-builder's **stdin**. One line:

```json
{"contractAddress":"0x12d66f87a04a9e220743712ce6d9bb1b5616b8fc","eventTopic":"0xa945e51eec50ab98c161376f0db4cf2aeba3ec92755fe2fcd388bdbbb80ff196","topics":["0xa945e51eec50ab98c161376f0db4cf2aeba3ec92755fe2fcd388bdbbb80ff196","0x1e8f9d67ec0cb430c1b25dbe840e8b1503feccc4864333a1e48f7d690ced303d"],"data":"0x0000000000000000000000000000000000000000000000000000000000003bc20000000000000000000000000000000000000000000000000000000061009c5b","blockNumber":"0xc501f5","logIndex":"0x68","transactionHash":"0x48b8b81d1895f8f639b79301983ebadf6097c80451fb01fecac2af4b1511b06c","blockHash":"0x46a48f87d78f96731c74609da20305129f6b9a1e9d456810981b6ea99048b6a7"}
```

`CanonicalEvent` fields (all lowercase `0x`-hex): `contractAddress`,
`eventTopic` (= `topics[0]`), `topics[]`, `data`, `blockNumber`, `logIndex`,
`transactionHash`, `blockHash`. Events are globally ordered by
`(blockNumber, logIndex)`.

### 7.4 OUTPUT — chunk file `${protocolId}-[${fromBlock},${toBlock}).jsonl.gz`

Gzip-compressed. Decompressed, it is **JSONL** — exactly the NDJSON above, one
`CanonicalEvent` per line, for the block range in the filename:

```
{"contractAddress":"0x12d6…","eventTopic":"0xa945…","topics":[…],"data":"0x…","blockNumber":"0xc50101","logIndex":"0x0","transactionHash":"0x…","blockHash":"0x…"}
{"contractAddress":"0x12d6…","eventTopic":"0xe9e5…","topics":[…],"data":"0x…","blockNumber":"0xc50187","logIndex":"0x2","transactionHash":"0x…","blockHash":"0x…"}
```

Immutable once written. An empty chunk (a scanned range with no events) is a
zero-byte payload — valid, and asserts "this range was scanned."

### 7.5 OUTPUT — hot-head file `${protocolId}-[${fromBlock},${toBlock}).hot.jsonl.gz`

Byte-identical format to a sealed chunk — JSONL of `CanonicalEvent`s, gzipped.
The only difference is the `.hot.` filename infix and that the manifest tracks
it in `hotHeads` rather than `availableStates`. At most one per protocol.

### 7.6 OUTPUT — manifest `index.json`

The index. Written to the output directory:

```json
{
  "availableStates": {
    "tornado-cash-1-eth-0.1": [
      {
        "fromBlock": "0x8b1d26",
        "toBlock": "0x9c00000",
        "file": "tornado-cash-1-eth-0.1-[0x8b1d26,0x9c00000).jsonl.gz",
        "size": "0xa4f3c2",
        "digest": {
          "type": "sha256",
          "data": "0x1234abcd…  (sha256 of the uncompressed JSONL)"
        }
      }
    ]
  },
  "hotHeads": {
    "tornado-cash-1-eth-0.1": {
      "fromBlock": "0x9c00000",
      "toBlock": "0x9d12abc",
      "file": "tornado-cash-1-eth-0.1-[0x9c00000,0x9d12abc).hot.jsonl.gz",
      "size": "0x1e240",
      "digest": { "type": "sha256", "data": "0x9abc…" }
    }
  }
}
```

- `availableStates[id]` — immutable sealed chunks, block-ordered. Cache forever.
- `hotHeads[id]` — at most one mutable entry per protocol; absent if none.
  Re-fetch every poll; its `file` URL changes whenever the range advances.
- `digest.data` — sha256 of the **uncompressed** JSONL; verify with
  `gunzip -c <file> | shasum -a 256`.
- `size` — the **compressed** file's byte length, `0x`-hex.

### 7.7 STATE — `cursor.json` (standalone scraper only)

The direct scraper CLI's resume pointer. The orchestrator does not use it.

```json
{
  "tornado-cash-1-eth-0.1": { "lastScrapedBlock": "0xc50200" }
}
```

### 7.8 STATE — `.orchestrator.lock`

Plain text: the pid of the running orchestrator. Created `O_EXCL` at tick start,
removed on exit; a stale lock (dead pid) is reclaimed automatically.

```
48273
```

---

## 8. The four CLIs

### scraper — `node dist/scraper/cli.js`

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

Emits NDJSON on stdout, a summary on stderr. Exit 0 on success, 1 on error.

### chunk-builder — `node dist/chunk-builder/cli.js`

```
--protocol-id <id>     required   manifest key + filename prefix
--from-block <hex>     required   inclusive start of the scanned range
--to-block <hex>       required   exclusive end of the scanned range
--output-dir <path>    required   chunks + index.json directory
--size-limit <n>       optional   max uncompressed bytes per chunk (default 10 MiB)
--dry-run              optional   compute metadata, write nothing
```

Reads NDJSON on stdin. The standalone CLI always seals the trailing partial
(no hot heads — that path is orchestrator-only).

### orchestrator — `node dist/orchestrator/cli.js`

```
--config <path>        required   config JSON (all protocols)
--rpc <url>            required   Ethereum JSON-RPC URL (one chain per run)
--output-dir <path>    required   chunks + index.json directory
--lock-dir <path>      optional   directory for .orchestrator.lock (default = output-dir)
--protocol-id <id>     optional   restrict to one protocol
--batch-size <n>       optional   blocks per batch (default 100000)
--confirmations <n>    optional   fallback reorg buffer (default 12)
--window <n>           optional   scraper window (default 2000)
--size-limit <n>       optional   chunk cap if config has none (default 10 MiB)
--dry-run              optional   report what would run, touch nothing
```

The intended cron entry point — one daily entry handles every protocol:

```
0 2 * * * cd /repo && node dist/orchestrator/cli.js --config ./config.json \
  --rpc https://ethereum-rpc.publicnode.com --output-dir ./chunks
```

### client — `node dist/client/cli.js`

The consumer CLI. Subcommands take a `<manifest-url>` (the manifest is read from
`<url>/index.json`); the query commands fetch **only** the manifest.

```
state-client <command> <manifest-url> [<protocol-id>] [options]

  protocols <url>            list every protocol + summary       (alias: ls)
  info      <url> <id>       range, download size, hot head, gap/contiguity check
  head      <url> <id>       latest covered block (alias: latest)
  chunks    <url> <id>       list a protocol's chunks
  stream    <url> <id>       download + verify + emit NDJSON

  --json                 machine-readable output instead of human tables
  --from-block <hex>     info/chunks/stream: lower bound of the block range
  --to-block <hex>       info/chunks/stream: upper bound (exclusive)
  --since-block <hex>    head: exit 3 if no block beyond this is covered
  --hot                  chunks: include the mutable hot head
  --cache-dir <path>     stream: local cache of verified sealed chunks
  --concurrency <n>      stream: parallel chunk fetches (default 4)
```

`stream` emits NDJSON on stdout + a summary on stderr; the query commands print a
human table or, with `--json`, structured JSON. Exit codes: 0 ok · 1 usage /
fetch / not-found · 3 `head --since-block` found nothing newer.

---

## 9. Running it

```bash
npm install
npm run build
npm test                       # ~141 unit tests

# orchestrator — the normal path
node dist/orchestrator/cli.js --config ./example-config.json \
  --rpc https://ethereum-rpc.publicnode.com --output-dir ./chunks

# manual scraper | chunk-builder pipe (note: scraper to-block is inclusive,
# chunk-builder to-block is exclusive, hence +1)
node dist/scraper/cli.js --config ./example-config.json \
  --protocol-id tornado-cash-1-eth-0.1 --rpc <url> \
  --from-block 0xC50101 --to-block 0xC50200 \
| node dist/chunk-builder/cli.js --protocol-id tornado-cash-1-eth-0.1 \
  --from-block 0xC50101 --to-block 0xC50201 --output-dir ./chunks

# verify a chunk against the manifest
gunzip -c ./chunks/<file>.jsonl.gz | shasum -a 256   # == digest in the manifest

# consume the published state (serve ./chunks over HTTP, then):
node dist/client/cli.js info   http://localhost:8080/ tornado-cash-1-eth-0.1
node dist/client/cli.js stream http://localhost:8080/ tornado-cash-1-eth-0.1 \
  --cache-dir ./client-cache > events.ndjson
```

---

## 10. Hosting on GCS

Publishing to Google Cloud Storage is entirely a `Store`-seam concern — the
scraper, chunk-builder logic, manifest/chunk format, and the client are all
unchanged. The producer points `--output-dir` at a bucket; consumers read the
same objects over plain HTTP.

- **Producer write** — `--output-dir gs://bucket[/prefix]` routes through
  `parseStoreTarget` → `GcsStore`. Chunks + `index.json` are written straight to
  the bucket with per-object `Cache-Control`: sealed chunks
  `max-age=31536000, immutable`, `index.json` / hot head `max-age=30`.
- **Consumer read** — point the client's manifest URL at the bucket
  (`https://storage.googleapis.com/<bucket>/`) or, later, a custom domain in front
  of Cloud CDN. `HttpStore` does plain GETs; **nothing in the client changes**.
- **Cloud CDN (optional)** — a backend bucket with `--enable-cdn
  --cache-mode=USE_ORIGIN_HEADERS` honors the `Cache-Control` above, so immutable
  chunks pin at the edge while the manifest re-validates. Needs an HTTPS load
  balancer + custom domain; until then the bucket URL works directly.
- **Running it** — `publish.sh` runs the orchestrator locally writing to
  `gs://$BUCKET` (uses ADC for auth, keeps the lockfile on the local FS). The
  natural next step is a **Cloud Run Job + Cloud Scheduler** with the RPC URL in
  Secret Manager; only *where* the orchestrator runs changes, not what it does.

Operational notes: the orchestrator lockfile is filesystem-only — for a `gs://`
target it defaults to the cwd (`--lock-dir` to override), and in a stateless
container single-execution scheduling is the real single-writer guard. Hot-head
objects orphan as their range advances; a GCS Object Lifecycle rule (delete
`*.hot.jsonl.gz` after N days) or a mirroring sync cleans them up. The bucket is
public-read — integrity comes from the sha256 digests, not access control.

---

## 11. Scope boundaries

Built and verified: scraper, chunk-builder, orchestrator, storage abstraction
(`DiskStore` + `HttpStore` + `GcsStore`), hot heads, batching, and the client
library + CLI.

Not yet built (and where they slot in):

- **`S3Store`** — an AWS publish-side store, mirroring `GcsStore`: one new class
  implementing `put`/`get`/`delete`/`list`, plus one `case "s3"` in `createStore`
  (and an `s3://` arm in `parseStoreTarget`); no other module changes.
- **Browser build of the client** — today the client uses `node:zlib` and
  `Buffer`, so it runs under Node only. Going isomorphic means gzip via
  `DecompressionStream`, `Buffer` → `Uint8Array`, and swapping `sha256Hex` to
  native `crypto.subtle` (which would drop `@noble/hashes` entirely).
- **Manifest signing** — the broader spec anticipates signed manifests; the
  client's verify path is where a signature check would extend. A publish-step
  concern, separate from the orchestrator.
- **Per-protocol storage / multi-chain in one run** — today one `Store` and one
  chain per orchestrator invocation.
