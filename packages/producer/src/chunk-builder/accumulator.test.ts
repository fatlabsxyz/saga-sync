import { describe, it, expect } from "vitest";
import type { CanonicalEvent } from "../scraper/normalize.js";
import { ChunkAccumulator } from "./accumulator.js";

const event = (block: bigint, logIndex = 0, padding = ""): CanonicalEvent => ({
  contractAddress: "0x12d66f87a04a9e220743712ce6d9bb1b5616b8fc",
  eventTopic: "0xa945e51eec50ab98c161376f0db4cf2aeba3ec92755fe2fcd388bdbbb80ff196",
  topics: ["0xa945e51eec50ab98c161376f0db4cf2aeba3ec92755fe2fcd388bdbbb80ff196"],
  data: `0x${"00".repeat(padding.length)}` as `0x${string}`,
  blockNumber: `0x${block.toString(16)}` as `0x${string}`,
  logIndex: `0x${logIndex.toString(16)}` as `0x${string}`,
});

describe("ChunkAccumulator", () => {
  it("emits no completed chunks while everything fits under the size limit", () => {
    const acc = new ChunkAccumulator(10_000, 0x10n);
    expect(acc.add(event(0x11n))).toBeNull();
    expect(acc.add(event(0x12n))).toBeNull();
    const { completed, trailing } = acc.finish();
    expect(completed).toBeNull();
    expect(trailing.events).toHaveLength(2);
    expect(trailing.fromBlock).toBe(0x10n);
  });

  it("completes a chunk at a block boundary when the size limit is crossed", () => {
    const big = "x".repeat(200); // each event ≈ 730 bytes
    const acc = new ChunkAccumulator(1000, 0x10n);
    // One event per block. Limit 1000 fits one event but not two — so when
    // block 0x13 arrives, the accumulated block 0x11 + pending 0x12 overflows
    // and block 0x11 is cut into its own chunk.
    expect(acc.add(event(0x11n, 0, big))).toBeNull();
    expect(acc.add(event(0x12n, 0, big))).toBeNull(); // commits 0x11 into the chunk
    const completed = acc.add(event(0x13n, 0, big));
    expect(completed).not.toBeNull();
    expect(completed!.from).toBe(0x10n);
    expect(completed!.to).toBe(0x12n); // sealed at the 0x12 block boundary, exclusive
    expect(completed!.events).toHaveLength(1); // just block 0x11's event
  });

  it("never splits events within the same block, even if oversized", () => {
    const big = "x".repeat(200);
    const acc = new ChunkAccumulator(400, 0x10n);
    // 4 events all at block 0x11 — way over 400 bytes, but one block
    for (let i = 0; i < 4; i++) expect(acc.add(event(0x11n, i, big))).toBeNull();
    // block 0x12 arrives — block 0x11 has no prior accumulated chunk to cut against,
    // so all 4 events stay together
    expect(acc.add(event(0x12n, 0, big))).toBeNull();
    const { completed } = acc.finish();
    // the cut happens now: block 0x11's 4 events form one (oversized) chunk
    expect(completed).not.toBeNull();
    expect(completed!.events).toHaveLength(4);
    expect(completed!.from).toBe(0x10n);
    expect(completed!.to).toBe(0x12n);
  });

  it("starts the first chunk's range at the constructor's chunkFrom (seed case)", () => {
    const acc = new ChunkAccumulator(10_000, 0x40n); // seeded chunkFrom well before events
    acc.add(event(0x50n));
    const { trailing } = acc.finish();
    expect(trailing.fromBlock).toBe(0x40n);
  });

  it("finish on an empty accumulator returns empty trailing at chunkFrom", () => {
    const acc = new ChunkAccumulator(10_000, 0x10n);
    const { completed, trailing } = acc.finish();
    expect(completed).toBeNull();
    expect(trailing.events).toEqual([]);
    expect(trailing.fromBlock).toBe(0x10n);
  });
});
