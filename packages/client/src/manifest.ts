import type { Store } from "@saga-sync/core";
import { Manifest as PublisherManifest } from "@saga-sync/core";
import type { ChunkMeta } from "@saga-sync/core";
import { ManifestSignatureError, verifyManifestSignature } from "@saga-sync/core";

// The client's view of a published manifest. Re-uses the publisher-side
// `Manifest` class for parsing + validation so the shape is defined in exactly
// one place; this file is the public re-export surface for consumers.
export type { ChunkMeta, ManifestData } from "@saga-sync/core";

export type LoadManifestOptions = {
  // When set, the manifest's detached Ed25519 signature (`${key}.sig`) is
  // verified against this 0x-hex public key before the manifest is parsed.
  // Mandatory once enabled: a missing or mismatched signature throws.
  publicKey?: string;
};

// Load and parse the manifest from a store. Throws if the manifest is absent
// (the publisher has not run yet, or the URL is wrong) or malformed. If a
// publicKey is supplied, the signature is verified first — over the raw bytes,
// before any of them are trusted.
export async function loadManifest(
  store: Store,
  key: string = "index.json",
  opts: LoadManifestOptions = {},
): Promise<PublisherManifest> {
  const raw = await store.get(key);
  if (!raw) throw new Error(`manifest not found at key "${key}"`);
  if (opts.publicKey) {
    const sig = await store.get(`${key}.sig`);
    if (!sig) {
      throw new ManifestSignatureError(
        `manifest signature "${key}.sig" not found, but a public key was configured`,
      );
    }
    verifyManifestSignature(raw, new TextDecoder().decode(sig).trim(), opts.publicKey);
  }
  return PublisherManifest.fromRaw(store, key, raw);
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
