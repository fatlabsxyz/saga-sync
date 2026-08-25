import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CanonicalRecord } from "@saga-sync/core";
import type { ScraperSource } from "../sources/index.js";
import { DiskStore } from "@saga-sync/core/node";
import { ChunkArchive } from "../chunk-builder/archive.js";
import { Manifest } from "@saga-sync/core";
import { runProtocolOnce } from "./pipeline.js";

const ADDRESS = `0x${"a".repeat(40)}` as `0x${string}`;
const TOPIC = `0x${"b".repeat(64)}` as `0x${string}`;

const event = (block: string, logIndex: string, data = "0x"): CanonicalRecord => ({
  contractAddress: ADDRESS,
  eventTopic: TOPIC,
  topics: [TOPIC],
  data,
  blockNumber: block,
  logIndex,
});

// runProtocolOnce drives ranges and chunking; where records come from is the
// source's business. A stub source keeps these tests about the composition.
const fakeSource = (...records: CanonicalRecord[]): ScraperSource => ({
  kind: "fake",
  async *fetch() {
    for (const r of records) yield r;
  },
  latestCoveredBlock: async () => 0n,
});

describe("runProtocolOnce", () => {
  let dir: string;
  let archive: ChunkArchive;
  let manifest: Manifest;
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "orch-pipeline-test-"));
    const store = new DiskStore(dir);
    archive = new ChunkArchive(store);
    manifest = await Manifest.load(store);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("composes scrape → chunk and seals one chunk for events under the size limit", async () => {
    const source = fakeSource(event("0x10", "0x0"), event("0x11", "0x0"));
    const { sealed } = await runProtocolOnce({
      source,
      protocolId: "proto",
      fromBlock: 0x10n,
      toBlock: 0x20n,
      sizeLimit: 100_000,
      archive,
      manifest,
    });
    expect(sealed).toHaveLength(1);
    expect(sealed[0]?.fromBlock).toBe("0x10");
    expect(sealed[0]?.toBlock).toBe("0x21"); // inclusive 0x20 → half-open 0x21
    expect(await archive.readEvents(sealed[0]!)).toHaveLength(2);
  });

  it("seals an empty chunk when the scrape returns no events", async () => {
    const source = fakeSource();
    const { sealed } = await runProtocolOnce({
      source,
      protocolId: "proto",
      fromBlock: 0x10n,
      toBlock: 0x20n,
      sizeLimit: 100_000,
      archive,
      manifest,
    });
    expect(sealed).toHaveLength(1);
    expect(await archive.readEvents(sealed[0]!)).toEqual([]);
    expect(sealed[0]?.digest.data).toBe(
      "0xe3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });

  it("splits at block boundaries when the size limit is exceeded", async () => {
    const big = `0x${"f".repeat(800)}`;
    const source = fakeSource(
      ...[0x10n, 0x11n, 0x12n, 0x13n].map((b) => event(`0x${b.toString(16)}`, "0x0", big)),
    );
    const { sealed } = await runProtocolOnce({
      source,
      protocolId: "proto",
      fromBlock: 0x10n,
      toBlock: 0x13n,
      sizeLimit: 1000,
      archive,
      manifest,
    });
    expect(sealed.length).toBeGreaterThan(1);
    for (let i = 1; i < sealed.length; i++) {
      expect(sealed[i - 1]?.toBlock).toBe(sealed[i]?.fromBlock);
    }
    expect(sealed[0]?.fromBlock).toBe("0x10");
    expect(sealed[sealed.length - 1]?.toBlock).toBe("0x14");
  });

  it("suspend mode returns the trailing accumulator instead of sealing it", async () => {
    const source = fakeSource(event("0x10", "0x0"), event("0x11", "0x0"));
    const result = await runProtocolOnce({
      source,
      protocolId: "proto",
      fromBlock: 0x10n,
      toBlock: 0x20n,
      sizeLimit: 100_000,
      archive,
      manifest,
      trailingMode: "suspend",
    });
    expect(result.sealed).toHaveLength(0);
    expect(result.trailing!.events).toHaveLength(2);
    expect(result.trailing!.toBlock).toBe(0x21n); // inclusive 0x20 → half-open 0x21
  });

  it("hot-head seed pre-loads the accumulator; sealed range starts at hot-head from", async () => {
    const big = `0x${"f".repeat(800)}`;
    const source = fakeSource(
      ...[0x10n, 0x11n, 0x12n, 0x13n].map((b) => event(`0x${b.toString(16)}`, "0x0", big)),
    );
    const result = await runProtocolOnce({
      source,
      protocolId: "proto",
      fromBlock: 0x10n,
      toBlock: 0x13n,
      sizeLimit: 1000,
      archive,
      manifest,
      hotHead: { events: [event("0x5", "0x0", big), event("0x6", "0x0", big)], fromBlock: 0x0n },
      trailingMode: "suspend",
    });
    expect(result.sealed.length).toBeGreaterThanOrEqual(1);
    // First sealed chunk starts at the hot-head's fromBlock, not the batch fromBlock.
    expect(result.sealed[0]?.fromBlock).toBe("0x0");
  });
});
