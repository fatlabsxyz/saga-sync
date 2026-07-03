# @saga-sync/client

The consumer side of **saga-sync** — the reference implementation of
[privacy-protocol-state-distribution](../../README.md). Given a manifest URL it
reconstructs a privacy protocol's event history by downloading the published
static files and **verifying every one** against the manifest — no trust in the
publisher beyond the manifest itself (and, optionally, its Ed25519 signature).

Install just this package to consume published state — it pulls in
[`@saga-sync/core`](../core) and `@noble/*`, and **nothing else**: no viem, no
`@google-cloud/storage`, no scraper.

```bash
npm install @saga-sync/client
```

Ships a library (`@saga-sync/client`) and a CLI (`state-client`). The library
entry is **browser-safe** — gzip via the web-standard `DecompressionStream`,
`Uint8Array` + `TextDecoder` instead of `Buffer`, no `node:` imports (a guard test
enforces it). The CLI and the optional disk cache are Node-only.

## Quick start (library)

```ts
import { Client } from "@saga-sync/client";

const client = new Client("https://cdn.example/pp-state/"); // dir holding index.json

// List what's published.
for (const id of await client.listProtocols()) console.log(id);

// Stream one protocol's full event history in block order.
for await (const event of client.streamEvents("tornado-cash-1-eth-0.1")) {
  // event: CanonicalEvent — { contractAddress, eventTopic, topics, data, blockNumber, logIndex }
  handle(event);
}
```

`streamEvents` returns an **`AsyncGenerator<CanonicalEvent>`**, not an array — you
consume it once with `for await`. That's a deliberate memory choice: events are
produced lazily and peak memory is bounded to roughly one decompressed chunk
(~10 MiB) × the fetch concurrency, **independent of total history size**, so you
can process a stream larger than RAM. It also means an early `break` never
downloads or verifies the chunks you didn't reach, and you start processing the
first chunk while later ones are still downloading. If you genuinely want the whole
array, collect it yourself:

```ts
const all: CanonicalEvent[] = [];
for await (const e of client.streamEvents(id)) all.push(e);
```

### Filtering

`streamEvents(id, opts)` accepts:

- **`from` / `to`** — restrict to a block range (`[from, to)`); only overlapping
  chunks are fetched.
- **`addresses`** — keep only events from these contract addresses.
- **`eventTopics`** — keep only these event `topic0`s (event types).

`addresses`/`eventTopics` are validated against the manifest's `trackedAddresses` /
`trackedEventTopics` and **throw** if you ask for something the stream doesn't track
— a mismatched filter is a bug, not a silently-empty result.

```ts
for await (const e of client.streamEvents(id, {
  from: "0x8b1d26",
  eventTopics: ["0xa945e51e…"], // Deposit only
})) { … }
```

## Verification model

Everything the client serves is verified — **cache hits included**:

- **`verifyDigest(meta, bytes)`** recomputes the sha256 of a chunk's uncompressed
  JSONL and compares it to the manifest entry; a mismatch throws
  `DigestMismatchError`.
- **`verifyChunkEvents(meta, events)`** then enforces the canonical form the digest
  can't catch on its own — every event within the chunk's `[from, to)` range and
  strictly ascending by `(blockNumber, logIndex)`; violations throw
  `CanonicalFormError`.
- A missing file throws `ChunkNotFoundError`, kept distinct from a digest mismatch
  so callers can tell "absent" from "tampered".

### Manifest signatures (optional)

Supply a publisher public key and the client fetches `index.json.sig` and verifies
the **Ed25519 signature over the raw `index.json` bytes before parsing** — mandatory
once enabled (missing or mismatched signature throws). Because the manifest holds
every chunk's digest, one signature transitively authenticates the whole dataset.

```ts
const client = new Client(baseUrl, { publicKey: "0x…" });
```

## Library API

- **`Client`** — `streamEvents(id, opts?)` (merged sealed chunks then the hot head,
  sealed fetched with a bounded-concurrency sliding window and optionally cached to
  a local `Store`), `listProtocols(prefix?)`, plus manifest inspection helpers.
- **`loadManifest(store, key, { publicKey? })`** — one fetch; verifies the signature
  when a key is supplied. Re-uses core's `Manifest` so the shape is defined once.
- **`decodeAndVerify` / `fetchChunkFrom(store, meta)`** — the fetch→gunzip→verify→
  parse→verify-canonical pipeline for a single chunk.
- **`verifyDigest` / `verifyChunkEvents`** and the error types above.

Reads go through core's `Store` seam (`HttpStore` for the network, an optional
local cache `Store`). Sealed chunks are safe to cache — immutable, content-
addressed, and re-verified on every read; the hot head is re-fetched every call and
never cached.

## CLI (`state-client`)

Subcommands take a `<manifest-url>` (the manifest is read from `<url>/index.json`);
the query commands fetch **only** the manifest — no chunk downloads.

```
state-client <command> <manifest-url> [<protocol-id>] [options]

  protocols <url>            list every protocol + summary       (alias: ls)
  info      <url> <id>       range, size, metadata, hot head, gap/contiguity check
  head      <url> <id>       latest covered block                (alias: latest)
  chunks    <url> <id>       list a protocol's chunks
  stream    <url> <id>       download + verify + emit NDJSON

  --json                 machine-readable output instead of human tables
  --from-block <hex>     info/chunks/stream: lower bound of the block range
  --to-block <hex>       info/chunks/stream: upper bound (exclusive)
  --address <hex>        stream: keep only these contract addresses (repeatable)
  --event-topic <hex>    stream: keep only these event topic0s (repeatable)
  --since-block <hex>    head: exit 3 if no block beyond this is covered
  --hot                  chunks: include the mutable hot head
  --cache-dir <path>     stream: local cache of verified sealed chunks
  --concurrency <n>      stream: parallel chunk fetches (default 4)
  --public-key <hex>     require + verify the manifest's Ed25519 signature
```

`stream` emits NDJSON on stdout + a summary on stderr; the query commands print a
human table or, with `--json`, structured JSON. `--public-key` applies to all
commands and verifies `index.json.sig` before trusting the manifest.

Exit codes: `0` ok · `1` usage / fetch / not-found · `3` `head --since-block` found
nothing newer.

```bash
# serve some published chunks, then:
node packages/client/dist/cli.js info   http://localhost:8080/ tornado-cash-1-eth-0.1
node packages/client/dist/cli.js stream http://localhost:8080/ tornado-cash-1-eth-0.1 \
  --cache-dir ./client-cache > events.ndjson
```

## Modules

- **`verify.ts`** — `verifyDigest` + `verifyChunkEvents` (both mandatory on every chunk).
- **`fetch.ts`** — `decodeAndVerify` + `fetchChunkFrom`; the per-chunk pipeline.
- **`manifest.ts`** — `loadManifest` + pure `selectSealedChunks` / `selectHotHead`
  range-overlap helpers + signature check.
- **`client.ts`** — the `Client` class and the merged streaming logic.
- **`format.ts`** — `humanBytes` + `table`, the CLI's rendering helpers.
- **`cli.ts`** — the `state-client` entry point.
- **`index.ts`** — the browser-safe library barrel.
