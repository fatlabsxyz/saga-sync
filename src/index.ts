// Browser-safe library entry point. Everything reachable from here uses only
// web-standard APIs (fetch, DecompressionStream, TextDecoder, Uint8Array,
// @noble) and no node: built-ins — so a bundler can pull it into a browser app
// with no polyfills. The CLIs, DiskStore, and GcsStore are intentionally NOT
// re-exported here (they are Node-only); import them from their own modules.

export { Client } from "./client/client.js";
export type { ClientOptions, StreamOptions } from "./client/client.js";
export { HttpStore } from "./storage/http-store.js";
export type { Store } from "./storage/store.js";

// Read helpers and the errors a consumer handles.
export { decodeAndVerify, fetchChunkFrom, ChunkNotFoundError } from "./client/fetch.js";
export { verifyDigest, DigestMismatchError } from "./client/verify.js";
export { loadManifest } from "./client/manifest.js";
export type { ChunkMeta, ManifestData, LoadManifestOptions } from "./client/manifest.js";

// Manifest signature verification (Ed25519) — consumers pin a public key.
export { verifyManifestSignature, ManifestSignatureError } from "./signing.js";

export type { CanonicalEvent } from "./scraper/normalize.js";
