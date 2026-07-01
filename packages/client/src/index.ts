// @saga-sync/client — browser-safe library entry point. Everything reachable
// from here uses only web-standard APIs (fetch, DecompressionStream,
// TextDecoder, Uint8Array, @noble) and no node: built-ins — so a bundler can
// pull it into a browser app with no polyfills. The CLI and DiskStore are
// intentionally NOT re-exported here (Node-only); import them from their own
// modules. HttpStore, the manifest schema, and signature verification come from
// @saga-sync/core.

export { Client } from "./client.js";
export type { ClientOptions, StreamOptions } from "./client.js";
export { HttpStore } from "@saga-sync/core";
export type { Store } from "@saga-sync/core";

// Read helpers and the errors a consumer handles.
export { decodeAndVerify, fetchChunkFrom, ChunkNotFoundError } from "./fetch.js";
export { verifyDigest, DigestMismatchError } from "./verify.js";
export { loadManifest } from "./manifest.js";
export type { ChunkMeta, ManifestData, LoadManifestOptions } from "./manifest.js";

// Manifest signature verification (Ed25519) — consumers pin a public key.
export { verifyManifestSignature, ManifestSignatureError } from "@saga-sync/core";

export type { CanonicalEvent } from "@saga-sync/core";
