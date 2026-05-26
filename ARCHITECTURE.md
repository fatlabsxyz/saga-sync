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

Three composable stages sit on top of one storage abstraction:

```
            ┌─────────┐   CanonicalEvent    ┌───────────────┐   .jsonl.gz chunks
  RPC  ───▶ │ scraper │ ─── NDJSON stream ─▶│ chunk-builder │ ─── + index.json ──▶ Store
            └─────────┘                     └───────────────┘
                  ▲                                 ▲
                  └────────────┬────────────────────┘
                        ┌──────────────┐
                        │ orchestrator │   cron entry point — composes the two
                        └──────────────┘   in-process, in block batches
                                 │
                        ┌──────────────┐
                        │    Store     │   disk today; S3/HTTP slot in later
                        └──────────────┘
```

- **scraper** — connects to an Ethereum JSON-RPC, fetches event logs for a
  protocol over a block range, normalizes them, emits them as NDJSON.
- **chunk-builder** — consumes that NDJSON, partitions it into size-bounded
  immutable chunks (gzip + blake3), and maintains an append-only `index.json`
  manifest. The trailing partial chunk is kept as a mutable **hot head**.
- **orchestrator** — the cron entry point. Loops over every protocol in the
  config and runs `scrape → chunk` for each, **in-process**, in block-range
  **batches**. Owns the hot-head lifecycle.
- **storage** — a `Store` interface abstracting all object persistence.
  `DiskStore` is the only backend today; the seam exists so S3 / CDN buckets can
  be added without touching anything else.

Each stage is **both a standalone CLI and an importable library**. The scraper
and chunk-builder can be run by hand and piped (`scraper | chunk-builder`); the
orchestrator imports them as libraries and composes them with no subprocesses.

---

## 2. Tech stack

- **Node ≥ 20**, **TypeScript** (strict, ESM, `module: Node16`).
- **Runtime dependencies** (3): `viem` (Ethereum RPC client), `zod` (config
  validation), `@noble/hashes` (blake3).
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
    index.ts          createStore() factory + re-exports
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
```

Every module has a sibling `*.test.ts` (vitest). ~91 unit tests; the pipeline is
also verified end-to-end against a live mainnet RPC.

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
- **`createStore(cfg)`** — maps `cfg.protocol` (`disk` | `s3` | `http` | `ftp`)
  to an implementation. Only `disk` exists; the rest throw a clear error. If
  `cfg.dryRun` is set, the result is wrapped in `DryRunStore`.

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
  build the JSONL, compute the blake3 digest of the **uncompressed** bytes, gzip,
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
   bytes would exceed `size_limit`. The digest is **blake3 of the uncompressed
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

Consumed by all three tools. `example-config.json`:

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
          "type": "blake3",
          "data": "0x1234abcd…  (blake3 of the uncompressed JSONL)"
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
      "digest": { "type": "blake3", "data": "0x9abc…" }
    }
  }
}
```

- `availableStates[id]` — immutable sealed chunks, block-ordered. Cache forever.
- `hotHeads[id]` — at most one mutable entry per protocol; absent if none.
  Re-fetch every poll; its `file` URL changes whenever the range advances.
- `digest.data` — blake3 of the **uncompressed** JSONL; verify with
  `gunzip <file> | blake3`.
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

## 8. The three CLIs

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

---

## 9. Running it

```bash
npm install
npm run build
npm test                       # ~91 unit tests

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
gunzip -c ./chunks/<file>.jsonl.gz   # → JSONL; blake3 of these bytes == digest
```

---

## 10. Scope boundaries

Built and verified: scraper, chunk-builder, orchestrator, storage abstraction,
hot heads, batching.

Not yet built (and where they slot in):

- **Client library** — downloads the manifest + chunks, verifies digests, hands
  raw `CanonicalEvent`s to an application. Would consume the same `Store` seam
  for its read path.
- **Non-disk stores** — `S3Store` / `HttpStore` are a single new class each plus
  one `case` in `createStore`; no other module changes.
- **Manifest signing** — the broader spec anticipates signed manifests; that is
  a publish-step concern, separate from the orchestrator.
- **Per-protocol storage / multi-chain in one run** — today one `Store` and one
  chain per orchestrator invocation.
