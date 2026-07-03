import type { Hex } from "./hex.js";
import type { Store } from "./store.js";
import type { ManifestSigner } from "./signing.js";

// One entry in the manifest — describes a sealed chunk or a hot head. Produced
// by ChunkArchive, stored by Manifest.
export type ChunkMeta = {
  fromBlock: Hex;
  toBlock: Hex;
  file: string;
  size: Hex;
  digest: { type: "sha256"; data: Hex };
};

// Everything the manifest records about one protocol stream: descriptive
// metadata (copied verbatim from the scraper config) plus its chunk pointers.
// `chunks` holds the immutable sealed chunks in block order; `hotHead` is the
// single mutable trailing chunk (absent when there is no in-progress tail).
// The metadata fields are optional so an entry the producer has not yet
// annotated (which has none) stays valid until the producer fills them from config.
export type ProtocolEntry = {
  protocol?: string;
  // Free-form passthrough from config — a blank slate for protocol-specific
  // metadata (e.g. Tornado `denomination`, Privacy Pools `asset`). Its keys are
  // treated as IMMUTABLE per stream: they are written once and never overwritten
  // (see setProtocolMeta), so changing them in config does not propagate, and
  // changing them would mislabel already-published chunks.
  protocolMetadata?: Record<string, unknown>;
  chainId?: Hex;
  trackedAddresses?: Hex[];
  trackedEventTopics?: Hex[];
  chunks: ChunkMeta[];
  hotHead?: ChunkMeta;
};

// The on-disk JSON shape (manifest v1). `availableProtocols` maps a protocol
// stream key to its metadata + chunk pointers.
//
// `version` is the format stamp (see MANIFEST_VERSION) — informational while the
// format is still in development. `updatedAt` is an ISO-8601 wall-clock stamp
// refreshed on every write — a cheap "how fresh is this?" signal that needs no
// chunk reads. `compression` declares the chunk codec; only "gzip" is produced today.
export type ManifestData = {
  version: number;
  updatedAt?: string;
  compression: "gzip";
  availableProtocols: Record<string, ProtocolEntry>;
};

// The metadata fields a producer supplies for a stream (config-derived).
export type ProtocolMeta = {
  protocol?: string;
  protocolMetadata?: Record<string, unknown>;
  chainId?: Hex;
  trackedAddresses?: Hex[];
  trackedEventTopics?: Hex[];
};

const MANIFEST_KEY = "index.json";

// The manifest format version this code stamps on write. The format is still in
// development, so there is a single version (1); the field is informational — the
// reader does not gate on it. It reads the `availableProtocols` shape and
// re-stamps this version on the next write (so a manifest carrying an older
// development stamp is transparently rewritten to the current one).
export const MANIFEST_VERSION = 1;

// GCS rate-limits mutations to a single object to ~1/second. Chunk-seal and
// hot-head updates rewrite the one manifest object, so writes are coalesced:
// a mutation updates memory and schedules a write no sooner than this interval
// after the last one. Bursts (many protocols finishing at once under parallel
// scraping) collapse into a single write. `flush()` forces the final write.
const WRITE_THROTTLE_MS = 1000;

export type ManifestLoadOptions = {
  // When set, each write also emits a detached `${key}.sig` signature over the
  // serialized manifest bytes. Producer-side only.
  signer?: ManifestSigner;
};

// Re-key an object with its keys sorted, so serialized output does not depend on
// insertion order (which, under parallel scraping, is nondeterministic).
function sortKeys<T>(obj: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.keys(obj).sort().map((k) => [k, obj[k]!]));
}

// Serialize one entry with a stable field order, omitting absent fields.
function orderedEntry(e: ProtocolEntry): Record<string, unknown> {
  return {
    ...(e.protocol !== undefined ? { protocol: e.protocol } : {}),
    ...(e.protocolMetadata !== undefined ? { protocolMetadata: e.protocolMetadata } : {}),
    ...(e.chainId !== undefined ? { chainId: e.chainId } : {}),
    ...(e.trackedAddresses !== undefined ? { trackedAddresses: e.trackedAddresses } : {}),
    ...(e.trackedEventTopics !== undefined ? { trackedEventTopics: e.trackedEventTopics } : {}),
    chunks: e.chunks,
    ...(e.hotHead !== undefined ? { hotHead: e.hotHead } : {}),
  };
}

// The pipeline's index. Holds the parsed manifest in memory; mutations update
// memory synchronously and schedule a coalesced, throttled write to the Store.
// Call `flush()` to guarantee durability (the producer does so at end of run).
// Single-writer only (the orchestrator's lockfile guarantees that).
export class Manifest {
  private signer?: ManifestSigner;

  private constructor(
    private readonly store: Store,
    private readonly key: string,
    private data: ManifestData,
  ) {}

  static async load(
    store: Store,
    key: string = MANIFEST_KEY,
    opts: ManifestLoadOptions = {},
  ): Promise<Manifest> {
    return Manifest.fromRaw(store, key, await store.get(key), opts);
  }

  // Parse already-fetched manifest bytes into a Manifest, so a caller that has
  // (or must presence-check) the bytes does not fetch them a second time. A
  // `null` raw yields an empty manifest — the publisher's first-run case.
  // Reads the `availableProtocols` shape; the `version` field is informational
  // (see MANIFEST_VERSION) and does not gate the read. Consumers that require the
  // manifest to exist null-check before calling.
  static fromRaw(
    store: Store,
    key: string,
    raw: Uint8Array | null,
    opts: ManifestLoadOptions = {},
  ): Manifest {
    let data: ManifestData = {
      version: MANIFEST_VERSION,
      compression: "gzip",
      availableProtocols: {},
    };
    if (raw) {
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(new TextDecoder().decode(raw)) as Record<string, unknown>;
      } catch (err) {
        throw new Error(`manifest ${key}: ${(err as Error).message}`);
      }
      data = {
        version: MANIFEST_VERSION,
        compression: "gzip",
        availableProtocols:
          parsed.availableProtocols && typeof parsed.availableProtocols === "object"
            ? (parsed.availableProtocols as Record<string, ProtocolEntry>)
            : {},
      };
      if (typeof parsed.updatedAt === "string") data.updatedAt = parsed.updatedAt;
    }
    const manifest = new Manifest(store, key, data);
    manifest.signer = opts.signer;
    return manifest;
  }

  // --- pure reads (no I/O) ---

  sealedChunks(protocolId: string): ChunkMeta[] {
    return this.data.availableProtocols[protocolId]?.chunks ?? [];
  }

  hotHead(protocolId: string): ChunkMeta | undefined {
    return this.data.availableProtocols[protocolId]?.hotHead;
  }

  // Descriptive metadata for a stream (undefined until the producer sets it).
  protocolName(protocolId: string): string | undefined {
    return this.data.availableProtocols[protocolId]?.protocol;
  }

  protocolMetadata(protocolId: string): Record<string, unknown> | undefined {
    return this.data.availableProtocols[protocolId]?.protocolMetadata;
  }

  trackedAddresses(protocolId: string): Hex[] | undefined {
    return this.data.availableProtocols[protocolId]?.trackedAddresses;
  }

  trackedEventTopics(protocolId: string): Hex[] | undefined {
    return this.data.availableProtocols[protocolId]?.trackedEventTopics;
  }

  chainId(protocolId: string): Hex | undefined {
    return this.data.availableProtocols[protocolId]?.chainId;
  }

  // Highest block any artifact (sealed chunk or hot head) covers for a protocol.
  // Robust to the post-crash overlap case where a sealed chunk consumed the hot
  // head's range but the hot-head entry wasn't yet cleared — takes the max.
  lastCoveredBlock(protocolId: string): bigint | null {
    const entry = this.data.availableProtocols[protocolId];
    const chunks = entry?.chunks;
    const last = chunks && chunks.length > 0 ? chunks[chunks.length - 1] : undefined;
    const sealedTo = last ? BigInt(last.toBlock) : null;
    const hotTo = entry?.hotHead ? BigInt(entry.hotHead.toBlock) : null;
    if (sealedTo === null && hotTo === null) return null;
    if (sealedTo === null) return hotTo;
    if (hotTo === null) return sealedTo;
    return sealedTo > hotTo ? sealedTo : hotTo;
  }

  // Every protocol id present, sorted. An id can appear with only a hot head (or
  // only metadata) if nothing has sealed yet.
  protocolIds(): string[] {
    return Object.keys(this.data.availableProtocols).sort();
  }

  // Lowest block covered for a protocol — the first sealed chunk's `fromBlock`,
  // or the hot head's if nothing has sealed yet. Null for an unknown protocol.
  firstCoveredBlock(protocolId: string): bigint | null {
    const entry = this.data.availableProtocols[protocolId];
    const chunks = entry?.chunks;
    if (chunks && chunks.length > 0) return BigInt(chunks[0]!.fromBlock);
    return entry?.hotHead ? BigInt(entry.hotHead.fromBlock) : null;
  }

  // Holes in a protocol's sealed-chunk chain: each consecutive pair whose ranges
  // are not adjacent, as the missing `[prev.toBlock, next.fromBlock)` range. An
  // empty array means the sealed history is contiguous. The hot head is excluded
  // — it is the live tail, not part of the sealed record.
  gaps(protocolId: string): { from: Hex; to: Hex }[] {
    const chunks = this.data.availableProtocols[protocolId]?.chunks ?? [];
    const holes: { from: Hex; to: Hex }[] = [];
    for (let i = 1; i < chunks.length; i++) {
      if (BigInt(chunks[i - 1]!.toBlock) !== BigInt(chunks[i]!.fromBlock)) {
        holes.push({ from: chunks[i - 1]!.toBlock, to: chunks[i]!.fromBlock });
      }
    }
    return holes;
  }

  // Manifest-wide metadata (not per-protocol).
  version(): number {
    return this.data.version;
  }

  updatedAt(): string | undefined {
    return this.data.updatedAt;
  }

  // Raw snapshot — for inspection and tests.
  snapshot(): ManifestData {
    return this.data;
  }

  // --- mutations (in-memory now; durable on the next coalesced write / flush) ---

  private entry(protocolId: string): ProtocolEntry {
    let e = this.data.availableProtocols[protocolId];
    if (!e) {
      e = { chunks: [] };
      this.data.availableProtocols[protocolId] = e;
    }
    return e;
  }

  appendChunk(protocolId: string, entry: ChunkMeta): Promise<void> {
    this.entry(protocolId).chunks.push(entry);
    return this.touch();
  }

  setHotHead(protocolId: string, entry: ChunkMeta): Promise<void> {
    this.entry(protocolId).hotHead = entry;
    return this.touch();
  }

  clearHotHead(protocolId: string): Promise<void> {
    const e = this.data.availableProtocols[protocolId];
    if (!e || e.hotHead === undefined) return Promise.resolve();
    delete e.hotHead;
    return this.touch();
  }

  // Fill a stream's descriptive metadata — WRITE-ONCE: only fields still unset
  // are populated, so config edits to an existing stream do not propagate (its
  // metadata describes chunks already published under the original values).
  setProtocolMeta(protocolId: string, meta: ProtocolMeta): Promise<void> {
    const e = this.entry(protocolId);
    let changed = false;
    if (e.protocol === undefined && meta.protocol !== undefined) {
      e.protocol = meta.protocol;
      changed = true;
    }
    if (e.protocolMetadata === undefined && meta.protocolMetadata !== undefined) {
      e.protocolMetadata = meta.protocolMetadata;
      changed = true;
    }
    if (e.chainId === undefined && meta.chainId !== undefined) {
      e.chainId = meta.chainId;
      changed = true;
    }
    if (e.trackedAddresses === undefined && meta.trackedAddresses !== undefined) {
      e.trackedAddresses = meta.trackedAddresses;
      changed = true;
    }
    if (e.trackedEventTopics === undefined && meta.trackedEventTopics !== undefined) {
      e.trackedEventTopics = meta.trackedEventTopics;
      changed = true;
    }
    return changed ? this.touch() : Promise.resolve();
  }

  // --- coalesced, throttled writer ---
  //
  // A mutation marks the state dirty and triggers a write only if enough time
  // has passed since the last one; otherwise the change waits for the next
  // mutation (which, during active scraping, always comes) or for flush(). This
  // coalesces bursts and bounds writes to ~1/WRITE_THROTTLE_MS with NO pending
  // timers — so nothing writes after the caller has stopped (important for a
  // clean shutdown and for tests). Durability is guaranteed by flush().

  private dirty = false;
  private writing = false;
  private writeChain: Promise<void> = Promise.resolve();
  private lastWriteMs = 0;

  private touch(): Promise<void> {
    this.dirty = true;
    this.maybeWrite(false);
    return Promise.resolve();
  }

  // Start a write if one is due (or `force`d) and none is in flight. Serialized
  // through writeChain so puts never overlap.
  private maybeWrite(force: boolean): void {
    if (!this.dirty || this.writing) return;
    if (!force && Date.now() - this.lastWriteMs < WRITE_THROTTLE_MS) return;
    this.writing = true;
    this.writeChain = this.writeChain
      .then(() => this.writeOnce())
      .catch(() => undefined)
      .finally(() => {
        this.writing = false;
      });
  }

  private async writeOnce(): Promise<void> {
    if (!this.dirty) return;
    this.dirty = false; // captured by the synchronous snapshot in persistToStore()
    try {
      await this.persistToStore();
      this.lastWriteMs = Date.now();
    } catch (err) {
      this.dirty = true; // failed — keep dirty so the next write / flush retries
      throw err;
    }
  }

  // Force all pending changes to the Store and wait until fully settled. Bypasses
  // the throttle (this is the final write of a run). Idempotent.
  async flush(): Promise<void> {
    do {
      this.maybeWrite(true);
      await this.writeChain;
    } while (this.dirty);
  }

  private async persistToStore(): Promise<void> {
    // Stamp the writer's version + a fresh timestamp, and emit a stable key order
    // (metadata first, protocol keys sorted) so the bytes are byte-identical
    // regardless of the order protocols were written — parallel scraping stays
    // reproducible.
    this.data.version = MANIFEST_VERSION;
    this.data.compression = "gzip";
    this.data.updatedAt = new Date().toISOString();
    const sorted = sortKeys(this.data.availableProtocols);
    const ordered = {
      version: this.data.version,
      updatedAt: this.data.updatedAt,
      compression: this.data.compression,
      availableProtocols: Object.fromEntries(
        Object.entries(sorted).map(([id, e]) => [id, orderedEntry(e)]),
      ),
    };
    const bytes = new TextEncoder().encode(JSON.stringify(ordered, null, 2) + "\n");
    await this.store.put(this.key, bytes);
    // Write the detached signature after the manifest so a reader that sees the
    // new .sig is reading against the new manifest. (The two objects are not
    // written atomically; a consumer that fetches a mismatched pair mid-publish
    // fails verification and retries.)
    if (this.signer) {
      await this.store.put(`${this.key}.sig`, new TextEncoder().encode(this.signer(bytes) + "\n"));
    }
  }
}
