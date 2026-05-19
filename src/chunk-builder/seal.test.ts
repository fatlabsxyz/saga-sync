import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import type { CanonicalEvent } from "../scraper/normalize.js";
import { sealChunk, buildJsonl, readChunkFile } from "./seal.js";

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

describe("buildJsonl", () => {
  it("returns an empty buffer for no events", () => {
    expect(buildJsonl([]).length).toBe(0);
  });

  it("joins events with newlines and a trailing newline", () => {
    const out = buildJsonl([event(), event({ logIndex: "0x1" })]).toString("utf8");
    expect(out.endsWith("\n")).toBe(true);
    expect(out.split("\n").filter((s) => s.length > 0)).toHaveLength(2);
  });
});

describe("sealChunk", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "seal-test-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("uses the canonical empty-input blake3 digest for an empty chunk", () => {
    const meta = sealChunk([], { from: 0xc50101n, to: 0xc50200n }, {
      outputDir: dir,
      protocolId: "proto",
      dryRun: false,
    });
    // Well-known empty-input blake3 hash (32 bytes).
    expect(meta.digest).toEqual({
      type: "blake3",
      data: "0xaf1349b9f5f9a1a6a0404dea36dcc9499bcb25c9adc112b7cc9a93cae41f3262",
    });
  });

  it("writes a .jsonl.gz that decompresses back to the original JSONL", () => {
    const events = [event(), event({ logIndex: "0x1" })];
    const meta = sealChunk(events, { from: 0xc50101n, to: 0xc50102n }, {
      outputDir: dir,
      protocolId: "proto",
      dryRun: false,
    });
    const decompressed = gunzipSync(readFileSync(join(dir, meta.file))).toString("utf8");
    expect(decompressed).toBe(events.map((e) => JSON.stringify(e)).join("\n") + "\n");
  });

  it("names files with lowercase hex and half-open range", () => {
    const meta = sealChunk([], { from: 0xc50101n, to: 0xc50200n }, {
      outputDir: dir,
      protocolId: "tornado-cash-1-eth-0.1",
      dryRun: false,
    });
    expect(meta.file).toBe("tornado-cash-1-eth-0.1-[0xc50101,0xc50200).jsonl.gz");
  });

  it("reports size as the compressed byte length", () => {
    const meta = sealChunk([event()], { from: 0xc50101n, to: 0xc50102n }, {
      outputDir: dir,
      protocolId: "proto",
      dryRun: false,
    });
    const stats = readFileSync(join(dir, meta.file));
    expect(BigInt(meta.size)).toBe(BigInt(stats.length));
  });

  it("leaves no temp file behind", () => {
    sealChunk([event()], { from: 0xc50101n, to: 0xc50102n }, {
      outputDir: dir,
      protocolId: "proto",
      dryRun: false,
    });
    const leftovers = readdirSync(dir).filter((f) => f.endsWith(".tmp"));
    expect(leftovers).toEqual([]);
  });

  it("skips disk writes in dry-run but still returns meta", () => {
    const meta = sealChunk([event()], { from: 0xc50101n, to: 0xc50102n }, {
      outputDir: dir,
      protocolId: "proto",
      dryRun: true,
    });
    expect(existsSync(join(dir, meta.file))).toBe(false);
    expect(meta.file).toBeTruthy();
    expect(meta.digest.type).toBe("blake3");
  });

  it("emits a .hot.jsonl.gz filename when hot is set", () => {
    const meta = sealChunk([event()], { from: 0xc50101n, to: 0xc50200n }, {
      outputDir: dir,
      protocolId: "tornado-cash-1-eth-0.1",
      dryRun: false,
      hot: true,
    });
    expect(meta.file).toBe("tornado-cash-1-eth-0.1-[0xc50101,0xc50200).hot.jsonl.gz");
    expect(existsSync(join(dir, meta.file))).toBe(true);
  });

  it("hot and sealed files with the same range have the same digest", () => {
    const events = [event(), event({ logIndex: "0x1" })];
    const range = { from: 0xc50101n, to: 0xc50200n };
    const sealedMeta = sealChunk(events, range, { outputDir: dir, protocolId: "p", dryRun: true });
    const hotMeta = sealChunk(events, range, {
      outputDir: dir,
      protocolId: "p",
      dryRun: true,
      hot: true,
    });
    expect(hotMeta.digest.data).toBe(sealedMeta.digest.data);
  });
});

describe("readChunkFile", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "read-chunk-test-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("round-trips events written by sealChunk", () => {
    const events = [event(), event({ blockNumber: "0xc50102", logIndex: "0x1" })];
    const meta = sealChunk(events, { from: 0xc50101n, to: 0xc50200n }, {
      outputDir: dir,
      protocolId: "proto",
      dryRun: false,
    });
    expect(readChunkFile(join(dir, meta.file))).toEqual(events);
  });

  it("returns an empty array for a chunk with no events", () => {
    const meta = sealChunk([], { from: 0xc50101n, to: 0xc50200n }, {
      outputDir: dir,
      protocolId: "proto",
      dryRun: false,
    });
    expect(readChunkFile(join(dir, meta.file))).toEqual([]);
  });

  it("round-trips events from a .hot.jsonl.gz file too", () => {
    const events = [event(), event({ logIndex: "0x1" }), event({ logIndex: "0x2" })];
    const meta = sealChunk(events, { from: 0xc50101n, to: 0xc50200n }, {
      outputDir: dir,
      protocolId: "proto",
      dryRun: false,
      hot: true,
    });
    expect(readChunkFile(join(dir, meta.file))).toEqual(events);
  });
});
