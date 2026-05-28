import type { Store } from "../storage/store.js";
import { Manifest as PublisherManifest } from "../chunk-builder/manifest.js";
import type { ChunkMeta } from "../chunk-builder/manifest.js";

// The client's view of a published manifest. Re-uses the publisher-side
// `Manifest` class for parsing + validation so the shape is defined in exactly
// one place; this file is the public re-export surface for consumers.
export type { ChunkMeta, ManifestData } from "../chunk-builder/manifest.js";

// Load and parse the manifest from a store. Throws if the manifest is absent
// (the publisher has not run yet, or the URL is wrong) or malformed.
export async function loadManifest(
  store: Store,
  key: string = "index.json",
): Promise<PublisherManifest> {
  const raw = await store.get(key);
  if (!raw) throw new Error(`manifest not found at key "${key}"`);
  return PublisherManifest.load(store, key);
}

// Pure helper: filter a protocol's sealed chunks down to those overlapping
// the requested half-open [fromBlock, toBlock) window. Skip is by chunk range
// only — straddling chunks yield all their events (the caller does any per-
// event filtering).
export function selectSealedChunks(
  chunks: ChunkMeta[],
  filter: { fromBlock?: bigint; toBlock?: bigint } = {},
): ChunkMeta[] {
  const from = filter.fromBlock;
  const to = filter.toBlock;
  return chunks.filter((c) => {
    const cFrom = BigInt(c.fromBlock);
    const cTo = BigInt(c.toBlock);
    if (from !== undefined && cTo <= from) return false; // chunk ends at or before window
    if (to !== undefined && cFrom >= to) return false; // chunk starts at or after window
    return true;
  });
}

// Pure helper: include the hot head only if it overlaps the window.
export function selectHotHead(
  hot: ChunkMeta | undefined,
  filter: { fromBlock?: bigint; toBlock?: bigint } = {},
): ChunkMeta | undefined {
  if (!hot) return undefined;
  const from = filter.fromBlock;
  const to = filter.toBlock;
  const hFrom = BigInt(hot.fromBlock);
  const hTo = BigInt(hot.toBlock);
  if (from !== undefined && hTo <= from) return undefined;
  if (to !== undefined && hFrom >= to) return undefined;
  return hot;
}
