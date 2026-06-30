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

// The on-disk JSON shape. `availableStates` holds immutable sealed chunks;
// `hotHeads` holds at most one mutable trailing entry per protocol.
//
// `version` lets a consumer reject a format it cannot parse (see
// MANIFEST_VERSION). `updatedAt` is an ISO-8601 wall-clock stamp refreshed on
// every write — a cheap "how fresh is this?" signal that needs no chunk reads.
// `compression` declares the chunk codec; only "gzip" is produced today.
export type ManifestData = {
  version: number;
  updatedAt?: string;
  compression: "gzip";
  availableStates: Record<string, ChunkMeta[]>;
  hotHeads?: Record<string, ChunkMeta>;
};

const MANIFEST_KEY = "index.json";

// The manifest format version this code writes, and the highest it can read. A
// manifest declaring a higher version is rejected rather than misparsed — bump
// this only alongside a backwards-incompatible layout change.
export const MANIFEST_VERSION = 1;

// The pipeline's index. Holds the parsed manifest in memory and persists
// atomically through the Store on every mutation — so a crash leaves the
// manifest consistent up to the last completed seal. Single-writer only
// (the orchestrator's lockfile guarantees that).
export type ManifestLoadOptions = {
  // When set, persist() also writes a detached `${key}.sig` signature over the
  // serialized manifest bytes on every write. Producer-side only.
  signer?: ManifestSigner;
};

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
  // Consumers that require the manifest to exist null-check before calling.
  static fromRaw(
    store: Store,
    key: string,
    raw: Uint8Array | null,
    opts: ManifestLoadOptions = {},
  ): Manifest {
    let data: ManifestData = {
      version: MANIFEST_VERSION,
      compression: "gzip",
      availableStates: {},
    };
    if (raw) {
      let parsed: ManifestData;
      try {
        parsed = JSON.parse(new TextDecoder().decode(raw)) as ManifestData;
      } catch (err) {
        throw new Error(`manifest ${key}: ${(err as Error).message}`);
      }
      // A version absent (legacy) is treated as v1; a version newer than we
      // understand is a hard stop, not a best-effort parse.
      const version = typeof parsed.version === "number" ? parsed.version : MANIFEST_VERSION;
      if (version > MANIFEST_VERSION) {
        throw new Error(
          `manifest ${key}: unsupported version ${version} (this client supports up to ${MANIFEST_VERSION})`,
        );
      }
      data = {
        version,
        compression: "gzip",
        availableStates:
          parsed.availableStates && typeof parsed.availableStates === "object"
            ? parsed.availableStates
            : {},
      };
      if (typeof parsed.updatedAt === "string") data.updatedAt = parsed.updatedAt;
      if (parsed.hotHeads && typeof parsed.hotHeads === "object") {
        data.hotHeads = parsed.hotHeads;
      }
    }
    const manifest = new Manifest(store, key, data);
    manifest.signer = opts.signer;
    return manifest;
  }

  // --- pure reads (no I/O) ---

  sealedChunks(protocolId: string): ChunkMeta[] {
    return this.data.availableStates[protocolId] ?? [];
  }

  hotHead(protocolId: string): ChunkMeta | undefined {
    return this.data.hotHeads?.[protocolId];
  }

  // Highest block any artifact (sealed chunk or hot head) covers for a protocol.
  // Robust to the post-crash overlap case where a sealed chunk consumed the hot
  // head's range but the hot-head entry wasn't yet cleared — takes the max.
  lastCoveredBlock(protocolId: string): bigint | null {
    const chunks = this.data.availableStates[protocolId];
    const last = chunks && chunks.length > 0 ? chunks[chunks.length - 1] : undefined;
    const sealedTo = last ? BigInt(last.toBlock) : null;
    const hot = this.data.hotHeads?.[protocolId];
    const hotTo = hot ? BigInt(hot.toBlock) : null;
    if (sealedTo === null && hotTo === null) return null;
    if (sealedTo === null) return hotTo;
    if (hotTo === null) return sealedTo;
    return sealedTo > hotTo ? sealedTo : hotTo;
  }

  // Every protocol id with any artifact (sealed chunk or hot head), sorted. A
  // protocol can appear with only a hot head if nothing has sealed yet.
  protocolIds(): string[] {
    const ids = new Set<string>(Object.keys(this.data.availableStates));
    if (this.data.hotHeads) for (const id of Object.keys(this.data.hotHeads)) ids.add(id);
    return [...ids].sort();
  }

  // Lowest block covered for a protocol — the first sealed chunk's `fromBlock`,
  // or the hot head's if nothing has sealed yet. Null for an unknown protocol.
  firstCoveredBlock(protocolId: string): bigint | null {
    const chunks = this.data.availableStates[protocolId];
    if (chunks && chunks.length > 0) return BigInt(chunks[0]!.fromBlock);
    const hot = this.data.hotHeads?.[protocolId];
    return hot ? BigInt(hot.fromBlock) : null;
  }

  // Holes in a protocol's sealed-chunk chain: each consecutive pair whose ranges
  // are not adjacent, as the missing `[prev.toBlock, next.fromBlock)` range. An
  // empty array means the sealed history is contiguous. The hot head is excluded
  // — it is the live tail, not part of the sealed record.
  gaps(protocolId: string): { from: Hex; to: Hex }[] {
    const chunks = this.data.availableStates[protocolId] ?? [];
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

  // --- mutations (each persists atomically via the Store) ---

  async appendChunk(protocolId: string, entry: ChunkMeta): Promise<void> {
    const list = this.data.availableStates[protocolId] ?? [];
    list.push(entry);
    this.data.availableStates[protocolId] = list;
    await this.persist();
  }

  async setHotHead(protocolId: string, entry: ChunkMeta): Promise<void> {
    const hotHeads = this.data.hotHeads ?? {};
    hotHeads[protocolId] = entry;
    this.data.hotHeads = hotHeads;
    await this.persist();
  }

  async clearHotHead(protocolId: string): Promise<void> {
    if (!this.data.hotHeads || !(protocolId in this.data.hotHeads)) return;
    delete this.data.hotHeads[protocolId];
    if (Object.keys(this.data.hotHeads).length === 0) delete this.data.hotHeads;
    await this.persist();
  }

  private async persist(): Promise<void> {
    // Stamp the writer's version + a fresh timestamp on every write, and emit a
    // stable key order (metadata first) so the bytes are predictable.
    this.data.version = MANIFEST_VERSION;
    this.data.compression = "gzip";
    this.data.updatedAt = new Date().toISOString();
    const ordered = {
      version: this.data.version,
      updatedAt: this.data.updatedAt,
      compression: this.data.compression,
      availableStates: this.data.availableStates,
      ...(this.data.hotHeads ? { hotHeads: this.data.hotHeads } : {}),
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
