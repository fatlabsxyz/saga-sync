import type { Hex } from "viem";
import type { Store } from "../storage/store.js";

// One entry in the manifest — describes a sealed chunk or a hot head. Produced
// by ChunkArchive, stored by Manifest.
export type ChunkMeta = {
  fromBlock: Hex;
  toBlock: Hex;
  file: string;
  size: Hex;
  digest: { type: "blake3"; data: Hex };
};

// The on-disk JSON shape. `availableStates` holds immutable sealed chunks;
// `hotHeads` holds at most one mutable trailing entry per protocol.
export type ManifestData = {
  availableStates: Record<string, ChunkMeta[]>;
  hotHeads?: Record<string, ChunkMeta>;
};

const MANIFEST_KEY = "index.json";

// The pipeline's index. Holds the parsed manifest in memory and persists
// atomically through the Store on every mutation — so a crash leaves the
// manifest consistent up to the last completed seal. Single-writer only
// (the orchestrator's lockfile guarantees that).
export class Manifest {
  private constructor(
    private readonly store: Store,
    private readonly key: string,
    private data: ManifestData,
  ) {}

  static async load(store: Store, key: string = MANIFEST_KEY): Promise<Manifest> {
    const raw = await store.get(key);
    let data: ManifestData = { availableStates: {} };
    if (raw) {
      let parsed: ManifestData;
      try {
        parsed = JSON.parse(raw.toString("utf8")) as ManifestData;
      } catch (err) {
        throw new Error(`manifest ${key}: ${(err as Error).message}`);
      }
      data = {
        availableStates:
          parsed.availableStates && typeof parsed.availableStates === "object"
            ? parsed.availableStates
            : {},
      };
      if (parsed.hotHeads && typeof parsed.hotHeads === "object") {
        data.hotHeads = parsed.hotHeads;
      }
    }
    return new Manifest(store, key, data);
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
    await this.store.put(
      this.key,
      Buffer.from(JSON.stringify(this.data, null, 2) + "\n", "utf8"),
    );
  }
}
