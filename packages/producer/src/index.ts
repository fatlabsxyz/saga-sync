// @saga-sync/producer — producer-side API. Day-to-day use is via the CLIs
// (scraper, chunk-builder, orchestrator); this entry exposes the pieces other
// packages compose against — e.g. the client's integration tests build fixtures
// with ChunkArchive, exactly as a real publisher would.
export { ChunkArchive, buildJsonl } from "./chunk-builder/archive.js";
export type { Range } from "./chunk-builder/archive.js";
