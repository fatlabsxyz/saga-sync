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
  hot head, **verifies every chunk's sha256** against the manifest (and optionally
  the manifest's **Ed25519 signature**), and yields the merged `CanonicalEvent`
  stream to an application. A browser-safe library; verifies everything it serves.
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
- **Runtime dependencies** (4): `viem` (Ethereum RPC client), `zod` (config
  validation), `@noble/hashes` (sha256), `@noble/curves` (Ed25519 manifest
  signing). The two `@noble` libs are pure-JS and isomorphic, so the consumer
  library is browser-safe (see §11).
- **Optional dependency**: `@google-cloud/storage`, used only by `GcsStore` and
  lazy-loaded — disk/http runs and consumers never load it (see §4.2).
- **Dev dependencies**: `typescript`, `@types/node`, `tsx`, `vitest`.
- Organized as an npm **workspace** (`saga-sync`) of three packages — see §3.
  Root `package.json` scripts: `build` / `typecheck` → `tsc -b` (TypeScript
  project references build all packages in dependency order), `test` →
  `vitest run`.
- `tsconfig.base.json` holds the shared compiler options (`target ES2022`,
  `module/moduleResolution Node16`, `strict`, `composite`); each package's
  `tsconfig.json` extends it with its own `rootDir src` / `outDir dist` and
  `references` to the packages it depends on. Test files are excluded from the build.
- No database, no message queue, no framework. State is plain files behind the
  `Store`.

---

## 3. Repository layout

An npm **workspace** (`saga-sync`) with three packages. The dependency graph is
a DAG — `client → core` and `producer → core`, with no runtime edge between
client and producer (client dev-depends on producer only to build fixtures in its
integration tests). Consumers install just `@saga-sync/client`, which pulls in
`@saga-sync/core` and `@noble/*` — no viem, no `@google-cloud/storage`, no
scraper.

```
packages/
  core/      @saga-sync/core — shared kernel. deps: @noble/* only (NO viem).
    src/                     browser-safe "." entry; Node-only DiskStore at "./node"
      hex.ts            Hex — 0x-string type alias (replaces viem's Hex)
      hash.ts           sha256Hex() — the one place the digest algorithm is named
      signing.ts        Ed25519 sign/verify of the manifest — the one place signing lives
      manifest.ts       Manifest class + ChunkMeta/ManifestData — the index.json schema
      events.ts         CanonicalEvent type — the persisted log shape (shared)
      store.ts          Store interface — put / get / delete / list (all async)
      http-store.ts     HttpStore: read-only fetch over a base URL (consumer side)
      disk-store.ts     DiskStore: local FS atomic write (exported from "./node")
      index.ts          browser-safe barrel;  node.ts re-exports DiskStore
  client/    @saga-sync/client — consumer lib + CLI. deps: core. bin: state-client.
    src/
      fetch.ts          decodeAndVerify + fetchChunkFrom — DecompressionStream gunzip, verify, parse
      verify.ts         verifyDigest (sha256) + verifyChunkEvents (range + ordering) vs manifest
      manifest.ts       loadManifest (+ optional signature check) + range helpers
      client.ts         Client class — merged streamEvents over sealed chunks + hot head
      format.ts         humanBytes + table — CLI rendering helpers
      cli.ts            client CLI; protocols/info/head/chunks/stream subcommands
      index.ts          browser-safe library entry (Client, verify helpers, re-exports from core)
  producer/  @saga-sync/producer — scrape + chunk + orchestrate + cloud stores.
    src/                     deps: core, viem, zod, (optional) @google-cloud/storage
      scraper/
        config.ts       load + zod-validate the config; loadConfig / loadAllProtocols
        normalize.ts    raw RPC log → CanonicalEvent (re-exports the type from core)
        scrape.ts       async generator: windowed eth_getLogs with adaptive split
        cursor.ts       Cursor class — standalone-scraper resume pointer
        cli.ts          scraper entry point; exports finalizedBlock, assertChainId
      chunk-builder/
        archive.ts      ChunkArchive class — encode/decode chunk files over a Store
        accumulator.ts  ChunkAccumulator class — block-aligned partition state machine
        cli.ts          chunk-builder entry point; exports processStream
      orchestrator/
        pipeline.ts     runProtocolOnce — composes scrape + chunk-builder in-process
        cli.ts          orchestrator entry point; lockfile, batch loop, hot-head lifecycle
      storage/
        gcs-store.ts    GcsStore: write to a GCS bucket (producer publish side)
        dry-run-store.ts DryRunStore: decorator that no-ops writes, delegates reads
        index.ts        createStore() factory + parseStoreTarget()
      keygen.ts         CLI: print an Ed25519 manifest-signing keypair
      index.ts          producer API barrel (ChunkArchive, for integration fixtures)
```

Every module has a sibling `*.test.ts` (vitest). ~181 unit tests; both the
producer pipeline and the client are verified end-to-end against
locally-published state served over HTTP (and the producer against a live
mainnet RPC). The browser library entry (`packages/client/src/index.ts`)
additionally bundles clean for the browser (no polyfills, no `node:` imports —
there is a guard test for this).

---

## 4. Modules in detail

Grouped by package (§3). Every module has a sibling `*.test.ts`.

### 4.1 `@saga-sync/core` — shared kernel

Schema, crypto, and the dependency-free stores both sides share. Browser-safe `.`
entry; the Node-only `DiskStore` is exported from `@saga-sync/core/node`.

`Store` is the one seam for persistence. Keys are flat object names; the interface
is async because S3/HTTP backends are inherently async.

```ts
interface Store {
  put(key: string, data: Uint8Array): Promise<void>;   // atomic — no partial reads
  get(key: string): Promise<Uint8Array | null>;        // null if absent
  delete(key: string): Promise<void>;                  // no error if absent
  list(prefix: string): Promise<string[]>;             // keys under a prefix
}
```

- **`DiskStore`** (`./node`) — backed by a base directory. `put` writes
  `${file}.${pid}.tmp` then `rename`s over the target; the rename is atomic on a
  single filesystem, so a crash mid-write never leaves a partial object. Used by
  the producer (local output) and the client CLI (chunk cache).
- **`HttpStore`** — read-only, backed by a base URL: `get` fetches
  `${baseUrl}/${key}`, returning `null` on 404. `put`/`delete`/`list` throw. The
  consumer read-side; pairs with a CDN-fronted bucket. Fetch-based, so browser-safe.
- **`hash.ts`** — `sha256Hex(bytes)`, the one place the digest algorithm is named;
  producer and consumer both go through it so digests agree. Pure `@noble` + its
  own hex (no `Buffer`), so it runs unchanged in a browser.
- **`signing.ts`** — manifest signing, the one place Ed25519 lives.
  `signManifest(bytes, secret)` / `verifyManifestSignature` over `@noble/curves`;
  `signerFromEnv()` builds a signer from the `MANIFEST_SIGNING_KEY` env var (a
  32-byte hex seed), which both producer CLIs pass to `Manifest`. A **detached
  signature over the raw `index.json` bytes** authenticates the publisher; because
  the manifest holds every chunk's digest, one signature transitively authenticates
  the whole dataset. Opt-in on both ends: the producer signs only when a key is
  set; the consumer verifies only when a public key is supplied (§4.3). Public-key
  distribution is out-of-band today (a pinned `--public-key`); an on-chain registry
  + key rotation are future work (§11).
- **`manifest.ts`** — the `Manifest` class wrapping a `Store`, plus the `ChunkMeta`
  / `ManifestData` types — the `index.json` schema, shared because the producer
  writes it and the client reads it. Holds `index.json` in memory; **every mutation
  persists atomically** (so a crash leaves the manifest consistent up to the last
  completed seal). Reads: `sealedChunks`, `hotHead`, `lastCoveredBlock`, `gaps`.
  Mutations: `appendChunk`, `setHotHead`, `clearHotHead`. With an optional
  **`signer`**, `persist()` also writes a detached `index.json.sig` over the
  serialized bytes on every write.
- **`events.ts`** — the `CanonicalEvent` type (the persisted log shape), shared:
  the producer's `normalize()` writes it, the client reconstructs it.
  **`hex.ts`** — the `Hex` = `` `0x${string}` `` alias replacing viem's `Hex`, so
  core (and client) carry no viem dependency.

### 4.2 `@saga-sync/producer` — scrape · chunk · orchestrate · publish

**`scraper/`** — pure "input range → output events"; writes no chunks or manifest.

- **`config.ts`** — reads the config JSON, zod-validates **only** the fields the
  pipeline uses. `loadConfig(path, protocolId)` returns one `ScraperTarget`;
  `loadAllProtocols(path)` returns all of them. Validated: `chainId`, `fromBlock`,
  `events[]`. Optional: `chunkSettings.maxSizeBytes`. Store target and schedule are
  deployment concerns, not config (see §7.1).
- **`normalize.ts`** — `normalize(rpcLog)` → `CanonicalEvent` (the type comes from
  core and is re-exported here for existing importers): lowercases every hex field,
  sets `eventTopic = topics[0]`, keeps the full `topics` array, and rejects pending
  logs (null block fields). Keeps indexed event args (commitments, nullifiers live
  in `topics[1..]`); drops only `transactionHash`/`blockHash` (incompressible, and
  unneeded given the reorg-safe scrape boundary).
- **`scrape.ts`** — `scrape(client, opts)` is an async generator yielding raw RPC
  logs. It slices `[fromBlock, toBlock]` into `window`-sized sub-ranges and, per
  sub-range, issues a raw `eth_getLogs` request per event filter. On a
  range/result-size error it **halves the window and retries** that sub-range. Each
  window is fully buffered and sorted by `(blockNumber, logIndex)` before any log
  is yielded, so a retry never double-emits.
- **`cursor.ts`** — `Cursor` class over a `Store`. Records `lastScrapedBlock` per
  protocol. **Only used by direct scraper-CLI runs**; the orchestrator derives
  resume points from the manifest instead.
- **`cli.ts`** — the scraper entry point. Also exports `finalizedBlock(client)`
  (the chain's own finalized block, or `null` if unsupported) and
  `assertChainId(client, expected)` (fails fast on a misconfigured RPC), reused by
  the orchestrator.

**`chunk-builder/`** — consumes `CanonicalEvent` NDJSON, produces chunk files +
drives core's `Manifest`.

- **`accumulator.ts`** — `ChunkAccumulator`, a **pure** (no-I/O) block-aligned
  partition state machine. Events are fed in order; it buffers the in-progress
  block separately and only commits it once the next block arrives — guaranteeing a
  chunk boundary always falls *between* blocks (a multi-event block is never
  split). `add(event)` returns a completed chunk when a size boundary was crossed;
  `finish()` returns the trailing accumulator.
- **`archive.ts`** — `ChunkArchive` over a `Store`. `seal()` / `writeHotHead()`
  build the JSONL, compute the sha256 digest of the **uncompressed** bytes, gzip,
  and `put` under a range-derived filename. `readEvents()` is the inverse
  (`get` + gunzip + parse). `buildJsonl()` is exported (and is what the client's
  integration tests use as a fixture builder).
- **`cli.ts`** — `processStream(lines, args)` drives the accumulator: feed seed
  events (a prior hot head, optional) → feed stream events, sealing each completed
  chunk through `ChunkArchive` + `Manifest` → handle the trailing accumulator,
  either **sealed** (`trailingMode: "seal"`, the standalone-CLI default) or
  **returned** (`trailingMode: "suspend"`, the orchestrator's hot-head carry-over).

**`orchestrator/`** — the cron entry point; composes the other two stages in-process.

- **`pipeline.ts`** — `runProtocolOnce(opts)` builds the scrape → normalize →
  NDJSON generator and hands it to `processStream`. No subprocess, no stdio piping:
  errors propagate as plain exceptions.
- **`cli.ts`** — per tick: acquire a lockfile, load the config and the manifest,
  query the chain tip, then for each protocol run `processProtocol` — which resolves
  the start block, loads any prior hot head, loops `[start, tip]` in `--batch-size`
  steps calling `runProtocolOnce`, and persists the final trailing accumulator as
  the new hot head. Also exports `acquireLock(path)`.

**`storage/`** — the producer-only stores + the factory.

- **`GcsStore`** — producer write-side, backed by a Google Cloud Storage bucket
  (optional `prefix`). GCS object writes are atomic + strongly consistent, so no
  temp-file+rename is needed. Sets `Content-Type` and `Cache-Control` per key
  (sealed chunks immutable + long-lived; `index.json` / hot head short TTL). The
  `@google-cloud/storage` SDK is lazy-loaded behind an injectable provider, so the
  module compiles + unit-tests without the dependency and no other path loads it.
- **`DryRunStore`** — decorates another `Store`; `put`/`delete` become no-ops,
  `get`/`list` pass through. How `--dry-run` is implemented — every other class
  stays oblivious to dry-run.
- **`createStore(cfg)`** / **`parseStoreTarget(target)`** — the factory maps
  `cfg.protocol` (`disk` | `http` | `gcs` | `s3` | `ftp`) to an implementation
  (`disk`→core's `DiskStore`, `http`→core's `HttpStore`, `gcs`→`GcsStore`;
  `s3`/`ftp` throw until added; `dryRun` wraps the result). `parseStoreTarget`
  resolves a producer `--output-dir`: a `gs://bucket[/prefix]` selects `GcsStore`,
  anything else is a local disk path. Shared by the orchestrator and chunk-builder CLIs.

**`keygen.ts`** — CLI that mints an Ed25519 manifest-signing keypair (over core's
`signing`).

### 4.3 `@saga-sync/client` — the consumer

Given a manifest URL it reconstructs a protocol's event history by downloading the
static files and verifying them — no trust in the publisher beyond the manifest
itself. Reads through the same `Store` seam (core's `HttpStore`), with an optional
local cache `Store`. Browser-safe (its `index.ts` is the bundle entry).

- **`verify.ts`** — `verifyDigest(meta, bytes)` recomputes the sha256 of a chunk's
  uncompressed JSONL and compares it to the manifest entry; mismatch throws
  `DigestMismatchError`. `verifyChunkEvents(meta, events)` then enforces the §3.3
  canonical form the digest can't catch on its own — every event in the chunk's
  `[fromBlock, toBlock)` range and strictly ascending by `(blockNumber, logIndex)`;
  violations throw `CanonicalFormError`. Both are **mandatory** on every chunk,
  cache hits included.
- **`fetch.ts`** — `decodeAndVerify` (gunzip via the web-standard
  `DecompressionStream` → verify digest → JSONL parse → verify canonical form) and
  `fetchChunkFrom(store, meta)`. A missing file throws `ChunkNotFoundError`,
  distinct from a digest mismatch so callers can tell "absent" from "tampered".
- **`manifest.ts`** — `loadManifest(store, key, { publicKey? })` (single fetch;
  throws if absent) plus pure `selectSealedChunks` / `selectHotHead` range-overlap
  helpers. When a `publicKey` is supplied it fetches `index.json.sig` and verifies
  the **Ed25519 manifest signature over the raw bytes before parsing** — mandatory
  once enabled (missing or mismatched signature throws). Re-uses core's `Manifest`
  class so the shape is defined once.
- **`client.ts`** — the `Client` class. `streamEvents(protocolId, {from,to})`
  yields the merged `CanonicalEvent` stream in block order: sealed chunks (fetched
  with a bounded-concurrency sliding window, yielded in submission order) then the
  hot head (re-fetched every call, never cached). Sealed chunks optionally cache to
  a local `Store` — safe because they are immutable and content-addressed, and
  re-verified on every read.
- **`format.ts`** — `humanBytes` + `table`, the CLI's rendering helpers.
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
      "chunkSettings": { "maxSizeBytes": 10485760 },
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

The config is *what to scrape*, not *where/when*: the **store target** is a per-run
CLI argument (`--output-dir <dir>` or a `gs://bucket/prefix`), shared by every
protocol in the config under one manifest; the **schedule** is external (cron / a
cloud scheduler).

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
{"contractAddress":"0x12d66f87a04a9e220743712ce6d9bb1b5616b8fc","eventTopic":"0xa945e51eec50ab98c161376f0db4cf2aeba3ec92755fe2fcd388bdbbb80ff196","topics":["0xa945e51eec50ab98c161376f0db4cf2aeba3ec92755fe2fcd388bdbbb80ff196","0x1e8f9d67ec0cb430c1b25dbe840e8b1503feccc4864333a1e48f7d690ced303d"],"data":"0x0000000000000000000000000000000000000000000000000000000000003bc20000000000000000000000000000000000000000000000000000000061009c5b","blockNumber":"0xc501f5","logIndex":"0x68"}
```

`CanonicalEvent` fields (all lowercase `0x`-hex): `contractAddress`,
`eventTopic` (= `topics[0]`), `topics[]`, `data`, `blockNumber`, `logIndex`.
Events are globally ordered by `(blockNumber, logIndex)`. `transactionHash` and
`blockHash` are intentionally **not** persisted — incompressible bloat,
unnecessary for state reconstruction, and redundant given the reorg-safe
(finalized) scrape boundary.

### 7.4 OUTPUT — chunk file `${protocolId}-[${fromBlock},${toBlock}).jsonl.gz`

Gzip-compressed. Decompressed, it is **JSONL** — exactly the NDJSON above, one
`CanonicalEvent` per line, for the block range in the filename:

```
{"contractAddress":"0x12d6…","eventTopic":"0xa945…","topics":[…],"data":"0x…","blockNumber":"0xc50101","logIndex":"0x0"}
{"contractAddress":"0x12d6…","eventTopic":"0xe9e5…","topics":[…],"data":"0x…","blockNumber":"0xc50187","logIndex":"0x2"}
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
  "version": 1,
  "updatedAt": "2026-06-11T14:00:00.000Z",
  "compression": "gzip",
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

- `version` — manifest format version (`1`). A consumer rejects a higher version
  rather than misparsing it (`MANIFEST_VERSION` in `manifest.ts`).
- `updatedAt` — ISO-8601 stamp refreshed on every manifest write; a freshness
  signal that needs no chunk reads.
- `compression` — chunk codec; `"gzip"` today.
- `availableStates[id]` — immutable sealed chunks, block-ordered. Cache forever.
- `hotHeads[id]` — at most one mutable entry per protocol; absent if none.
  Re-fetch every poll; its `file` URL changes whenever the range advances.
- `digest.data` — sha256 of the **uncompressed** JSONL; verify with
  `gunzip -c <file> | shasum -a 256`.
- `size` — the **compressed** file's byte length, `0x`-hex.
- **`index.json.sig`** (optional, sibling object) — when the producer is run with
  a signing key, a detached `0x`-hex **Ed25519 signature over the exact
  `index.json` bytes**, rewritten on every manifest write. Absent ⇒ unsigned
  (still sha256-verifiable, just not publisher-authenticated).

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

### scraper — `node packages/producer/dist/scraper/cli.js`

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

### chunk-builder — `node packages/producer/dist/chunk-builder/cli.js`

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

### orchestrator — `node packages/producer/dist/orchestrator/cli.js`

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
0 2 * * * cd /repo && node packages/producer/dist/orchestrator/cli.js --config ./config.json \
  --rpc https://ethereum-rpc.publicnode.com --output-dir ./chunks
```

### client — `node packages/client/dist/cli.js`

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
  --public-key <hex>     require + verify the manifest's Ed25519 signature
```

`stream` emits NDJSON on stdout + a summary on stderr; the query commands print a
human table or, with `--json`, structured JSON. `--public-key` applies to all
commands and, when set, verifies `index.json.sig` before trusting the manifest.
Exit codes: 0 ok · 1 usage / fetch / not-found · 3 `head --since-block` found
nothing newer.

> Producer signing is configured by the **`MANIFEST_SIGNING_KEY`** env var (a
> 32-byte hex Ed25519 seed) on the orchestrator / chunk-builder; `node
> packages/producer/dist/keygen.js` prints a fresh keypair. Set it before a run to publish a signed
> `index.json.sig`; consumers pin the matching public key via `--public-key`.

---

## 9. Running it

```bash
npm install
npm run build
npm test                       # ~171 unit tests

# orchestrator — the normal path
node packages/producer/dist/orchestrator/cli.js --config ./example-config.json \
  --rpc https://ethereum-rpc.publicnode.com --output-dir ./chunks

# manual scraper | chunk-builder pipe (note: scraper to-block is inclusive,
# chunk-builder to-block is exclusive, hence +1)
node packages/producer/dist/scraper/cli.js --config ./example-config.json \
  --protocol-id tornado-cash-1-eth-0.1 --rpc <url> \
  --from-block 0xC50101 --to-block 0xC50200 \
| node packages/producer/dist/chunk-builder/cli.js --protocol-id tornado-cash-1-eth-0.1 \
  --from-block 0xC50101 --to-block 0xC50201 --output-dir ./chunks

# verify a chunk against the manifest
gunzip -c ./chunks/<file>.jsonl.gz | shasum -a 256   # == digest in the manifest

# consume the published state (serve ./chunks over HTTP, then):
node packages/client/dist/cli.js info   http://localhost:8080/ tornado-cash-1-eth-0.1
node packages/client/dist/cli.js stream http://localhost:8080/ tornado-cash-1-eth-0.1 \
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
- **Consumer read** — point the client's manifest URL at the Cloud CDN endpoint
  in front of the bucket (`http://<lb-ip>/`), or at the bucket directly
  (`https://storage.googleapis.com/<bucket>/`). `HttpStore` does plain GETs;
  **nothing in the client changes** — the URL is just an argument.
- **Cloud CDN (`deploy/cdn.sh`)** — an external HTTP load balancer with a backend
  bucket created `--enable-cdn --cache-mode=USE_ORIGIN_HEADERS`, which honors the
  `Cache-Control` above so immutable chunks pin at the edge while the manifest
  re-validates. Served over plain HTTP on the LB's anycast IP — no domain/TLS,
  because the signed manifest + content-verified chunks guarantee integrity
  end-to-end and the data is public. A custom domain over HTTPS is a later add
  (managed cert + HTTPS proxy + `:443` rule on the same IP).
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
(`DiskStore` + `HttpStore` + `GcsStore`), hot heads, batching, the client library
+ CLI, **Ed25519 manifest signing**, and a **browser-safe consumer library**.

**Browser-safe client (done).** The consumer library uses only web-standard APIs
that also exist in Node 18+ — gzip via `DecompressionStream`, `Uint8Array` +
`TextDecoder`/`TextEncoder` instead of `Buffer`, hex via `@noble`'s own utils — so
`packages/client/src/index.ts` bundles for the browser with no polyfills (a guard
test asserts no `node:` imports in its graph). `@noble` stays (it is already isomorphic); native
`crypto.subtle` was deemed unnecessary. The CLI, producer, and `DiskStore`/
`GcsStore` remain Node-only by design.

**Manifest signing (done, opt-in).** Detached Ed25519 over the raw `index.json`
(§4.1 / §4.3 / §7.6). Producer signs when `MANIFEST_SIGNING_KEY` is set; consumer
verifies when a `--public-key` is supplied.

Not yet built (and where they slot in):

- **`S3Store`** — an AWS publish-side store, mirroring `GcsStore`: one new class
  implementing `put`/`get`/`delete`/`list`, plus one `case "s3"` in `createStore`
  (and an `s3://` arm in `parseStoreTarget`); no other module changes.
- **Signing: key distribution + rotation** — signing itself is built, but the
  public key is pinned out-of-band today. The anticipated on-chain key registry
  and a rotation/revocation story are future work; the client's verify path is
  where on-chain key resolution would slot in.
- **Browser cache backend** — the client runs cache-less in a browser today
  (`DiskStore` is Node-only); an `IndexedDbStore` implementing `Store` drops into
  the existing `cache?: Store` seam.
- **Per-protocol storage / multi-chain in one run** — today one `Store` and one
  chain per orchestrator invocation.
