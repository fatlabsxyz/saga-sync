import type { CanonicalEvent } from "@saga-sync/core";
import type { Hex } from "@saga-sync/core";
import type { Store } from "@saga-sync/core";
import type { ChunkMeta } from "@saga-sync/core";
import { Manifest } from "@saga-sync/core";
import { decodeAndVerify, fetchChunkFrom, ChunkNotFoundError } from "./fetch.js";
import { loadManifest, selectSealedChunks, selectHotHead } from "./manifest.js";

export type ClientOptions = {
  // Where the published manifest + chunks live. Typically an HttpStore over
  // a CDN URL; a DiskStore works for local round-trip testing.
  source: Store;
  // Optional local store for verified sealed chunks. Sealed chunks are
  // immutable and content-addressed, so a cache hit is always safe; the
  // digest is re-verified on every read to guard against bitrot. Hot heads
  // bypass the cache entirely.
  cache?: Store;
  // Max concurrent chunk fetches. Most network time is RTT-bound, so a small
  // value (default 4) is plenty.
  concurrency?: number;
  // 0x-hex Ed25519 public key. When set, the manifest's detached signature is
  // verified against it on every fetch (missing/mismatched signature throws).
  publicKey?: string;
};

export type StreamOptions = {
  fromBlock?: bigint;
  toBlock?: bigint;
  // Restrict the stream to events emitted by these contract addresses. Useful
  // for a stream that tracks more than one address (see the manifest's
  // `trackedAddresses`). Case-insensitive. This is a post-decode filter — every
  // chunk in the block range is still fetched and verified — so it trims what
  // the caller sees, not what is downloaded. Passing an address the stream does
  // not track throws (guards against silently receiving zero events).
  addresses?: Hex[];
  // Restrict the stream to these event types by `topic0` (the event-signature
  // hash, = `eventTopic`). Most streams track several event types (e.g. Tornado
  // Deposit + Withdrawal); this keeps only the requested ones. Same semantics as
  // `addresses`: case-insensitive, post-decode, and throws on a topic the stream
  // does not track (see the manifest's `trackedEventTopics`).
  eventTopics?: Hex[];
};

const DEFAULT_CONCURRENCY = 4;

// The consumer's entry point. Holds a (source, optional cache) pair and offers
// three layers: raw manifest, single chunk, and a merged streamEvents iterator
// across sealed chunks + the hot head.
export class Client {
  private readonly source: Store;
  private readonly cache: Store | undefined;
  private readonly concurrency: number;
  private readonly publicKey: string | undefined;

  constructor(opts: ClientOptions) {
    this.source = opts.source;
    this.cache = opts.cache;
    this.concurrency = opts.concurrency ?? DEFAULT_CONCURRENCY;
    this.publicKey = opts.publicKey;
    if (!Number.isInteger(this.concurrency) || this.concurrency < 1) {
      throw new Error(`concurrency must be a positive integer; got ${opts.concurrency}`);
    }
  }

  // Layer 1: fetch and parse the manifest (verifying its signature when a public
  // key was configured).
  fetchManifest(key: string = "index.json"): Promise<Manifest> {
    return loadManifest(this.source, key, { publicKey: this.publicKey });
  }

  // Layer 2: fetch one chunk by its manifest entry. Goes through the cache
  // path (for sealed chunks) so callers get the same efficiency as
  // streamEvents.
  fetchChunk(meta: ChunkMeta, opts: { hot?: boolean } = {}): Promise<CanonicalEvent[]> {
    return opts.hot ? fetchChunkFrom(this.source, meta) : this.fetchSealed(meta);
  }

  // Layer 1.5: discover the protocol streams a manifest publishes. Streams are
  // granular per-pool (e.g. "tornado-cash-1-eth-0.1", "tornado-cash-1-dai-100"),
  // so passing the family prefix "tornado-cash-1" returns every denomination's
  // id — the enumeration a consumer needs before it can pick or fan out over
  // streamEvents. Omit `prefix` to list everything; result is sorted.
  async listProtocols(prefix?: string): Promise<string[]> {
    const ids = (await this.fetchManifest()).protocolIds();
    return (prefix === undefined ? ids : ids.filter((id) => matchesFamily(id, prefix))).sort();
  }

  // Layer 3: merged event stream for a protocol. Yields events in block order
  // across all sealed chunks in the optional [fromBlock, toBlock) window,
  // then the hot head (re-fetched every call, never cached).
  async *streamEvents(
    protocolId: string,
    opts: StreamOptions = {},
  ): AsyncGenerator<CanonicalEvent, void, void> {
    const manifest = await this.fetchManifest();
    const sealed = selectSealedChunks(manifest.sealedChunks(protocolId), opts);
    const hot = selectHotHead(manifest.hotHead(protocolId), opts);
    const keepAddress = buildSetFilter(
      protocolId,
      opts.addresses,
      manifest.trackedAddresses(protocolId),
      "address(es)",
      (e) => e.contractAddress,
    );
    const keepTopic = buildSetFilter(
      protocolId,
      opts.eventTopics,
      manifest.trackedEventTopics(protocolId),
      "event topic(s)",
      (e) => e.eventTopic,
    );
    const keep = (e: CanonicalEvent): boolean => keepAddress(e) && keepTopic(e);

    for await (const events of this.fetchSealedOrdered(sealed)) {
      for (const event of events) if (keep(event)) yield event;
    }

    if (hot) {
      const events = await fetchChunkFrom(this.source, hot);
      for (const event of events) if (keep(event)) yield event;
    }
  }

  // Cache-aware sealed fetch: check cache → on miss, fetch from source, verify,
  // populate cache. Verification runs on both paths so every byte the
  // application sees was just verified.
  private async fetchSealed(meta: ChunkMeta): Promise<CanonicalEvent[]> {
    if (this.cache) {
      const cached = await this.cache.get(meta.file);
      if (cached) return await decodeAndVerify(cached, meta);
    }
    const compressed = await this.source.get(meta.file);
    if (!compressed) throw new ChunkNotFoundError(meta);
    const events = await decodeAndVerify(compressed, meta);
    if (this.cache) await this.cache.put(meta.file, compressed);
    return events;
  }

  // Sliding window — keep up to `concurrency` sealed-chunk fetches in flight;
  // yield them strictly in submission order so consumers see events in
  // block-range order regardless of which fetch finished first. Per-chunk
  // peak memory is one decompressed chunk (~10 MiB); across chunks it is
  // bounded by `concurrency`.
  private async *fetchSealedOrdered(
    metas: ChunkMeta[],
  ): AsyncGenerator<CanonicalEvent[], void, void> {
    const queue: Promise<CanonicalEvent[]>[] = [];
    let next = 0;
    while (next < metas.length && queue.length < this.concurrency) {
      queue.push(this.fetchSealed(metas[next++]!));
    }
    while (queue.length > 0) {
      const events = await queue.shift()!;
      if (next < metas.length) queue.push(this.fetchSealed(metas[next++]!));
      yield events;
    }
  }
}

// A protocol id belongs to a family if it equals the prefix or extends it by a
// "-" segment, so "tornado-cash-1" matches "tornado-cash-1-eth-0.1" but not an
// unrelated id that merely starts with the same characters.
function matchesFamily(id: string, prefix: string): boolean {
  return id === prefix || id.startsWith(`${prefix}-`);
}

// Build a per-event predicate for streamEvents' `addresses`/`eventTopics`
// filters. No `requested` → keep everything. Otherwise match (case-insensitively)
// on the field `pick` returns, after asserting every requested value is one the
// stream actually tracks — a typo'd or wrong-stream value fails loudly instead
// of silently yielding nothing. `tracked` is the manifest's advertised set (may
// be undefined on a pre-metadata manifest, in which case the guard is skipped).
function buildSetFilter(
  protocolId: string,
  requested: Hex[] | undefined,
  tracked: Hex[] | undefined,
  label: string,
  pick: (event: CanonicalEvent) => Hex,
): (event: CanonicalEvent) => boolean {
  if (requested === undefined) return () => true;
  const want = new Set(requested.map((v) => v.toLowerCase()));
  if (tracked) {
    const trackedSet = new Set(tracked.map((v) => v.toLowerCase()));
    const unknown = [...want].filter((v) => !trackedSet.has(v));
    if (unknown.length > 0) {
      throw new Error(
        `stream "${protocolId}" does not track ${label}: ${unknown.join(", ")}. ` +
          `Tracked: ${tracked.join(", ")}`,
      );
    }
  }
  return (event) => want.has(pick(event).toLowerCase());
}
