import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CanonicalEvent } from "../scraper/normalize.js";
import { DiskStore } from "../storage/disk-store.js";
import { ChunkArchive } from "../chunk-builder/archive.js";
import { decodeAndVerify, fetchChunkFrom, ChunkNotFoundError } from "./fetch.js";
import { DigestMismatchError } from "./verify.js";

const event = (overrides: Partial<CanonicalEvent> = {}): CanonicalEvent => ({
  contractAddress: "0x12d66f87a04a9e220743712ce6d9bb1b5616b8fc",
  eventTopic: "0xa945e51eec50ab98c161376f0db4cf2aeba3ec92755fe2fcd388bdbbb80ff196",
  topics: ["0xa945e51eec50ab98c161376f0db4cf2aeba3ec92755fe2fcd388bdbbb80ff196"],
  data: "0x",
  blockNumber: "0xc50101",
  logIndex: "0x0",
  transactionHash: "0xaa",
  blockHash: "0xbb",
  ...overrides,
});

describe("fetch", () => {
  let dir: string;
  let store: DiskStore;
  let archive: ChunkArchive;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "client-fetch-test-"));
    store = new DiskStore(dir);
    archive = new ChunkArchive(store);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("round-trips a sealed chunk: decode + verify == original events", async () => {
    const events = [event(), event({ logIndex: "0x1" })];
    const meta = await archive.seal("p", events, { from: 0xc50101n, to: 0xc50102n });
    const got = await fetchChunkFrom(store, meta);
    expect(got).toEqual(events);
  });

  it("handles an empty chunk (range scanned, no events)", async () => {
    const meta = await archive.seal("p", [], { from: 0x1n, to: 0x2n });
    expect(await fetchChunkFrom(store, meta)).toEqual([]);
  });

  it("throws ChunkNotFoundError when the store has no such file", async () => {
    const meta = await archive.seal("p", [event()], { from: 1n, to: 2n });
    await store.delete(meta.file);
    await expect(fetchChunkFrom(store, meta)).rejects.toThrow(ChunkNotFoundError);
  });

  it("throws DigestMismatchError when the manifest digest is wrong", async () => {
    const events = [event()];
    const meta = await archive.seal("p", events, { from: 1n, to: 2n });
    const tampered = { ...meta, digest: { type: "sha256" as const, data: "0xdead" as const } };
    await expect(fetchChunkFrom(store, tampered)).rejects.toThrow(DigestMismatchError);
  });

  it("decodeAndVerify rejects compressed bytes whose digest does not match", async () => {
    const events = [event()];
    const meta = await archive.seal("p", events, { from: 1n, to: 2n });
    const realBytes = await store.get(meta.file);
    const wrongMeta = { ...meta, digest: { type: "sha256" as const, data: "0xbeef" as const } };
    await expect(decodeAndVerify(realBytes!, wrongMeta)).rejects.toThrow(DigestMismatchError);
  });
});
