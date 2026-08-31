# @saga-sync/core

The shared kernel of **saga-sync** — the reference implementation of
[privacy-protocol-state-distribution](../../README.md). It holds the manifest
schema, the crypto (sha256 digests + Ed25519 signing), and the dependency-free
`Store` abstraction that both the producer and the consumer build on.

Both sides depend on core so the manifest/chunk shape and the digest algorithm
are defined **exactly once**:

```
client → core        producer → core        (no runtime edge client ↔ producer)
```

Consumers install [`@saga-sync/client`](../client), which pulls this in; producers
install [`@saga-sync/producer`](../producer). You rarely depend on core directly.

## Entry points

- **`@saga-sync/core`** — the browser-safe barrel (no `node:` imports, no
  `Buffer`): `Manifest`, `ChunkMeta`/`ManifestData` types, `sha256Hex`, the
  signing helpers, `CanonicalEvent`, `Hex`, `Store`, `HttpStore`.
- **`@saga-sync/core/node`** — re-exports the Node-only `DiskStore` (atomic
  local-filesystem persistence). Kept out of the browser bundle.

## The `Store` seam

`Store` is the one abstraction for persistence. Keys are flat object names; the
interface is async because HTTP/S3 backends are inherently async.

```ts
interface Store {
  put(key: string, data: Uint8Array): Promise<void>;   // atomic — no partial reads
  get(key: string): Promise<Uint8Array | null>;        // null if absent
  delete(key: string): Promise<void>;                  // no error if absent
  list(prefix: string): Promise<string[]>;             // keys under a prefix
}
```

- **`DiskStore`** (`/node`) — backed by a base directory. `put` writes
  `${file}.${pid}.tmp` then `rename`s over the target; the rename is atomic on a
  single filesystem, so a crash mid-write never leaves a partial object. Used by
  the producer (local output) and the client CLI (chunk cache).
- **`HttpStore`** — read-only, backed by a base URL: `get` fetches
  `${baseUrl}/${key}`, returning `null` on 404; `put`/`delete`/`list` throw. The
  consumer read-side; pairs with a CDN-fronted bucket. Fetch-based, so browser-safe.

The producer's `GcsStore` and the factory that selects a backend live in
[`@saga-sync/producer`](../producer), not here — core stays dependency-light.

## `Manifest`

`Manifest` wraps a `Store` and owns `index.json` — the index the producer writes
and the client reads. It holds the manifest in memory and persists atomically on
mutation. The **normative on-the-wire schema** is in the root
[SPEC.md §3.1](../../SPEC.md); this is the class API.

- **Reads**: `sealedChunks(id)`, `hotHead(id)`, `protocolIds()`,
  `firstCoveredBlock(id)` / `lastCoveredBlock(id)`, `gaps(id)`, plus the metadata
  accessors `protocolName`/`protocolMetadata`/`chainId`/`trackedAddresses`/
  `trackedEventTopics`.
- **Mutations** (serialized through an internal mutex): `appendChunk`,
  `setHotHead`, `clearHotHead`, and the **write-once** `setProtocolMeta(id, …)` —
  it fills only fields still unset, so `protocolMetadata` is immutable per stream
  once first written.
- **Format**: `MANIFEST_VERSION = 1`. The format is still in development, so the
  `version` field is informational — `fromRaw` reads the `availableProtocols`
  shape and does not gate on the number (a manifest carrying an older development
  stamp is read and transparently re-stamped on the next write). `persist()`
  serializes keys **sorted** and **coalesces/throttles** writes (so the bytes stay
  order-independent and under a GCS object's write-rate limit); `flush()` forces
  any pending write to land.
- **Signing** (optional): construct with `signers` and every `persist()` also
  writes a detached `index.json.sigs` envelope over the exact serialized bytes,
  plus the legacy bare-hex `index.json.sig` whenever one of them is Ed25519. (The
  older single-function `signer` option still works and writes only `.sig`.)

## Crypto

- **`hash.ts` — `sha256Hex(bytes)`** — the one place the digest algorithm is
  named; producer and consumer both go through it so digests agree. Pure `@noble`
  + its own hex (no `Buffer`), so it runs unchanged in a browser.
- **`signing.ts`** — the one place signature algorithms live.
  `signManifest(bytes, secret, alg)` / `verifyManifestSignatures` over
  `@noble/curves`; `signersFromEnv()` builds one signer per configured key
  (`MANIFEST_SIGNING_KEY` → Ed25519, `MANIFEST_SIGNING_KEY_SECP256K1` →
  secp256k1, both 32-byte hex seeds). A detached signature over the raw
  `index.json` bytes authenticates the publisher; because the manifest holds every
  chunk's digest, one signature transitively authenticates the whole dataset.
  Opt-in on both ends.

  A manifest may carry one signature per algorithm and a consumer is accepted by
  **any** of them, so the trust root is only as strong as the **weakest** key you
  publish under. Extra algorithms buy reach (Ethereum tooling, hardware wallets),
  not strength — see SPEC §9.1.

- **`secp256k1.ts`** (subpath `@saga-sync/core/secp256k1`) — registers ECDSA over
  secp256k1 as an available algorithm. Kept out of the default entry so a browser
  consumer that only verifies Ed25519 does not ship the curve: the client's
  browser bundle measures **18.7 KB gzipped** without it and **25.3 KB** with it.
  Node entry points import it unconditionally.

  ```ts
  import "@saga-sync/core/secp256k1"; // now a 33-byte public key verifies
  ```

## Shared types

- **`events.ts` — `CanonicalRecord`** — what a chunk line is: a `CanonicalEvent`
  (log) or a `CanonicalEntity` (indexer-derived, e.g. Railgun operations, which
  exist only in calldata). `isEntityRecord()` narrows. Entities sort by
  `(blockNumber, transactionIndex, opIndex)` — a chain coordinate, so an
  independent derivation produces identical bytes — and never share a stream with
  logs, whose provenance is checkable and theirs is not. See SPEC §3.4.
- **`events.ts` — `CanonicalEvent`** — the persisted log shape: all-lowercase
  `0x`-hex `contractAddress`, `eventTopic` (= `topics[0]`), `topics[]`, `data`,
  `blockNumber`, `logIndex`. The producer's `normalize()` writes it; the client
  reconstructs it.
- **`hex.ts` — `Hex`** — the `` `0x${string}` `` alias replacing viem's `Hex`, so
  core (and client) carry no viem dependency.

## Dependencies

`@noble/hashes` + `@noble/curves` only — both pure-JS and isomorphic. No viem, no
`@google-cloud/storage`, no `node:` imports on the `.` entry.
