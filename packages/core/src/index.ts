// @saga-sync/core — the shared kernel: schema, crypto, and the dependency-free
// Store implementations. Browser-safe: everything reachable from here uses only
// web-standard APIs (fetch, TextEncoder/Decoder, Uint8Array) and @noble, with no
// node: built-ins. The Node-only DiskStore is exported separately from
// "@saga-sync/core/node".
export type { Hex } from "./hex.js";
export { sha256Hex } from "./hash.js";
export type { Store } from "./store.js";
export { HttpStore } from "./http-store.js";
export type { CanonicalEvent } from "./events.js";

export { Manifest, MANIFEST_VERSION } from "./manifest.js";
export type { ChunkMeta, ManifestData, ManifestLoadOptions } from "./manifest.js";

export {
  ManifestSignatureError,
  verifyManifestSignature,
  signManifest,
  generateKeyPair,
  publicKeyFromSecret,
  signerFromEnv,
} from "./signing.js";
export type { ManifestSigner, KeyPair } from "./signing.js";
