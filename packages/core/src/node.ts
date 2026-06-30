// @saga-sync/core/node — the Node-only slice of core. DiskStore uses node:fs, so
// it is kept out of the browser-safe "." entry and imported explicitly by
// Node consumers (the producer, and the client CLI's local cache).
export { DiskStore } from "./disk-store.js";
