# Architecture — privacy-protocol-state-distribution

Reference implementation of a pipeline that distributes the on-chain event
state of privacy protocols (Tornado Cash, Privacy Pools, Railgun, …) as
verifiable, independently-downloadable chunks.

The chain is the source of truth but it is expensive and slow to read in bulk.
This pipeline scrapes a protocol's events once, packages them into immutable
compressed chunks with integrity digests, and publishes an index — so any number
of clients can reconstruct the protocol's state by downloading static files and
verifying them, instead of each re-scraping the chain.

This document is the **cross-package map** — how the pieces fit and where to read
next. It stays deliberately thin:

- The **protocol** (manifest / chunk / config JSON shapes, normalization rules) is
  in the root [README.md](README.md); the **normative spec** is in
  [SPEC.md](SPEC.md), with [SPEC_DIGEST.md](SPEC_DIGEST.md) tracking spec↔code deltas.
- The **per-package internals** — every module, CLI, data format, and invariant —
  live in each package's own README (see §4). Other implementations that produce a
  spec-conforming manifest + chunks are equally valid.

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
  over a CDN) exist today; `GcsStore` publishes to Google Cloud Storage. The seam
  exists so S3 buckets can be added without touching anything else.

The scraper, chunk-builder, and orchestrator ship in
[`@saga-sync/producer`](packages/producer); the client in
[`@saga-sync/client`](packages/client); the `Store` seam, manifest schema, and
crypto in [`@saga-sync/core`](packages/core). Each stage is **both a standalone
CLI and an importable library** — the scraper and chunk-builder can be piped by
hand (`scraper | chunk-builder`); the orchestrator and client import them as
libraries and compose with no subprocesses.

---

## 2. Tech stack

- **Node ≥ 20**, **TypeScript** (strict, ESM, `module: Node16`).
- **Runtime dependencies** (4): `viem` (Ethereum RPC client), `zod` (config
  validation), `@noble/hashes` (sha256), `@noble/curves` (Ed25519 manifest
  signing). The two `@noble` libs are pure-JS and isomorphic, so the consumer
  library is browser-safe (§6).
- **Optional dependency**: `@google-cloud/storage`, used only by `GcsStore` and
  lazy-loaded — disk/http runs and consumers never load it.
- **Dev dependencies**: `typescript`, `@types/node`, `tsx`, `vitest`.
- Organized as a pnpm **workspace** (`saga-sync`) of three packages (§3). Root
  `package.json` scripts: `build` / `typecheck` → `tsc -b` (project references
  build all packages in dependency order), `test` → `vitest run`.
- `tsconfig.base.json` holds the shared compiler options (`target ES2022`,
  `module/moduleResolution Node16`, `strict`, `composite`); each package's
  `tsconfig.json` extends it with its own `rootDir src` / `outDir dist` and
  `references` to the packages it depends on. Test files are excluded from the build.
- No database, no message queue, no framework. State is plain files behind the
  `Store`.

---

## 3. Repository layout

A pnpm **workspace** (`saga-sync`) with three packages. The dependency graph is
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

Every module has a sibling `*.test.ts` (vitest). ~209 unit tests; both the
producer pipeline and the client are verified end-to-end against
locally-published state served over HTTP (and the producer against a live
mainnet RPC). The browser library entry (`packages/client/src/index.ts`)
additionally bundles clean for the browser (no polyfills, no `node:` imports —
there is a guard test for this).

---

## 4. Package documentation

Each package README is self-contained (and is the package's npm landing page).
The internals, CLIs, data formats, and invariants that used to live in this file
now live with the code they describe:

| Read | For |
|---|---|
| [`packages/core/README.md`](packages/core/README.md) | the `Store` seam, the `Manifest` class API, sha256/Ed25519 crypto, shared `CanonicalEvent`/`Hex` types |
| [`packages/producer/README.md`](packages/producer/README.md) | the scraper / chunk-builder / orchestrator CLIs (flags + worked examples), module internals, every input/output data format, the producer invariants, and publishing to GCS |
| [`packages/client/README.md`](packages/client/README.md) | the `Client` library (streaming, filters, verification, signatures) and the `state-client` CLI |
| [`DEPLOY.md`](DEPLOY.md) | running the producer as a Cloud Run Job + Scheduler behind Cloud CDN |
| [`SPEC.md`](SPEC.md) | the normative wire spec; the **algorithms & invariants** a replica must honor are stated here, with the producer README giving the operational restatement |

---

## 5. Block-range conventions

A cross-cutting subtlety worth stating once at the system level (the packages
restate it where they use it):

- The **scraper** works in **inclusive** ranges `[fromBlock, toBlock]` — what
  `eth_getLogs` takes.
- **Chunks and the manifest** use **half-open** ranges `[fromBlock, toBlock)` — so
  consecutive chunks compose with no gap or overlap: each entry's `toBlock` equals
  the next entry's `fromBlock`.
- The orchestrator bridges them: a scraper batch covering inclusive `[X, Y]`
  becomes a chunk-builder range of half-open `[X, Y+1)`.

Invariant: a protocol's sealed chunks + its hot head partition
`[firstSealed.fromBlock, hotHead.toBlock)` contiguously.

---

## 6. Running it

```bash
pnpm install
pnpm build
pnpm test                       # ~209 unit tests

# orchestrator — the normal producer path
node packages/producer/dist/orchestrator/cli.js --config ./example-config.json \
  --rpc https://ethereum-rpc.publicnode.com --output-dir ./chunks

# verify a chunk against the manifest
gunzip -c ./chunks/<file>.jsonl.gz | shasum -a 256   # == digest in the manifest

# consume the published state (serve ./chunks over HTTP, then):
node packages/client/dist/cli.js info   http://localhost:8080/ tornado-cash-1-eth-0.1
node packages/client/dist/cli.js stream http://localhost:8080/ tornado-cash-1-eth-0.1 \
  --cache-dir ./client-cache > events.ndjson
```

See the [producer](packages/producer/README.md) and
[client](packages/client/README.md) READMEs for the manual `scraper | chunk-builder`
pipe, every flag, and the library APIs.

---

## 7. Scope boundaries

Built and verified: scraper, chunk-builder, orchestrator, storage abstraction
(`DiskStore` + `HttpStore` + `GcsStore`), hot heads, batching, the client library
+ CLI, **Ed25519 manifest signing**, and a **browser-safe consumer library**.

**Browser-safe client (done).** The consumer library uses only web-standard APIs
that also exist in Node 18+ — gzip via `DecompressionStream`, `Uint8Array` +
`TextDecoder`/`TextEncoder` instead of `Buffer`, hex via `@noble`'s own utils — so
`packages/client/src/index.ts` bundles for the browser with no polyfills (a guard
test asserts no `node:` imports in its graph). The CLI, producer, and `DiskStore`/
`GcsStore` remain Node-only by design.

**Manifest signing (done, opt-in).** Detached Ed25519 over the raw `index.json`.
Producer signs when `MANIFEST_SIGNING_KEY` is set; consumer verifies when a
`--public-key` is supplied.

Not yet built (and where they slot in):

- **`S3Store`** — an AWS publish-side store, mirroring `GcsStore`: one new class
  implementing `put`/`get`/`delete`/`list`, plus one `case "s3"` in `createStore`
  (and an `s3://` arm in `parseStoreTarget`); no other module changes.
- **Signing: key distribution + rotation** — signing itself is built, but the
  public key is pinned out-of-band today. An on-chain key registry and a
  rotation/revocation story are future work; the client's verify path is where
  on-chain key resolution would slot in.
- **Browser cache backend** — the client runs cache-less in a browser today
  (`DiskStore` is Node-only); an `IndexedDbStore` implementing `Store` drops into
  the existing `cache?: Store` seam.
- **Per-protocol storage / multi-chain in one run** — today one `Store` and one
  chain per orchestrator invocation.
