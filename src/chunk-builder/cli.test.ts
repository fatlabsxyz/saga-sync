import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CanonicalEvent } from "../scraper/normalize.js";
import { processStream, type ProcessArgs } from "./cli.js";
import { readManifest } from "./manifest.js";

const event = (block: bigint, logIndex = 0, padding = ""): CanonicalEvent => ({
  contractAddress: "0x12d66f87a04a9e220743712ce6d9bb1b5616b8fc",
  eventTopic: "0xa945e51eec50ab98c161376f0db4cf2aeba3ec92755fe2fcd388bdbbb80ff196",
  topics: ["0xa945e51eec50ab98c161376f0db4cf2aeba3ec92755fe2fcd388bdbbb80ff196"],
  // Padding lives in the `data` field so we can control event byte size.
  data: `0x${"00".repeat(padding.length)}` as `0x${string}`,
  blockNumber: `0x${block.toString(16)}` as `0x${string}`,
  logIndex: `0x${logIndex.toString(16)}` as `0x${string}`,
  transactionHash: "0xaa",
  blockHash: "0xbb",
});

async function* asyncLines(...events: CanonicalEvent[]): AsyncGenerator<string> {
  for (const e of events) yield JSON.stringify(e);
}

const baseArgs = (dir: string): Omit<ProcessArgs, "sizeLimit"> => ({
  protocolId: "proto",
  fromBlock: 0x64n, // 100
  toBlock: 0xc8n, // 200
  outputDir: dir,
  dryRun: false,
});

describe("processStream", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "chunk-cli-test-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("emits one empty chunk covering the full range when stdin is empty", async () => {
    const { sealed } = await processStream(asyncLines(), {
      ...baseArgs(dir),
      sizeLimit: 1024,
    });
    expect(sealed).toHaveLength(1);
    expect(sealed[0]?.fromBlock).toBe("0x64");
    expect(sealed[0]?.toBlock).toBe("0xc8");
    const manifest = readManifest(join(dir, "index.json"));
    expect(manifest.availableStates["proto"]).toHaveLength(1);
  });

  it("emits one chunk when all events fit under the size limit", async () => {
    const { sealed } = await processStream(
      asyncLines(event(0x65n), event(0x66n), event(0x67n)),
      { ...baseArgs(dir), sizeLimit: 10_000 },
    );
    expect(sealed).toHaveLength(1);
    expect(sealed[0]?.fromBlock).toBe("0x64");
    expect(sealed[0]?.toBlock).toBe("0xc8");
  });

  it("splits at a block boundary when the limit would be exceeded", async () => {
    // Each event ~250 bytes; with 2 per block and a 600-byte limit, block 0x65
    // fits and block 0x66 forces a split.
    const big = "x".repeat(200);
    const { sealed } = await processStream(
      asyncLines(
        event(0x65n, 0, big),
        event(0x65n, 1, big),
        event(0x66n, 0, big),
        event(0x66n, 1, big),
      ),
      { ...baseArgs(dir), sizeLimit: 600 },
    );
    expect(sealed).toHaveLength(2);
    // Chunks compose: chunk1.toBlock === chunk2.fromBlock.
    expect(sealed[0]?.toBlock).toBe(sealed[1]?.fromBlock);
    expect(sealed[0]?.fromBlock).toBe("0x64");
    expect(sealed[1]?.toBlock).toBe("0xc8");
  });

  it("never splits events within the same block, even if oversized", async () => {
    // Block 0x65 alone is 4 * ~250 bytes = ~1000 bytes, well over the 400 limit.
    // The chunk-boundary algorithm must keep all 4 events in one chunk.
    const big = "x".repeat(200);
    const { sealed } = await processStream(
      asyncLines(
        event(0x65n, 0, big),
        event(0x65n, 1, big),
        event(0x65n, 2, big),
        event(0x65n, 3, big),
        event(0x66n, 0, big),
      ),
      { ...baseArgs(dir), sizeLimit: 400 },
    );
    expect(sealed).toHaveLength(2);
    // First chunk ends at 0x66 — i.e., includes all of block 0x65.
    expect(sealed[0]?.fromBlock).toBe("0x64");
    expect(sealed[0]?.toBlock).toBe("0x66");
    expect(sealed[1]?.fromBlock).toBe("0x66");
    expect(sealed[1]?.toBlock).toBe("0xc8");
  });

  it("rejects events outside the scanned range", async () => {
    await expect(
      processStream(asyncLines(event(0x32n)), { ...baseArgs(dir), sizeLimit: 1024 }),
    ).rejects.toThrow(/outside scanned range/);
  });

  it("rejects events at or after --to-block (half-open upper)", async () => {
    await expect(
      processStream(asyncLines(event(0xc8n)), { ...baseArgs(dir), sizeLimit: 1024 }),
    ).rejects.toThrow(/outside scanned range/);
  });

  it("updates the manifest with one entry per sealed chunk", async () => {
    const big = "x".repeat(200);
    await processStream(
      asyncLines(event(0x65n, 0, big), event(0x66n, 0, big), event(0x67n, 0, big)),
      { ...baseArgs(dir), sizeLimit: 300 },
    );
    const manifest = readManifest(join(dir, "index.json"));
    const list = manifest.availableStates["proto"] ?? [];
    expect(list.length).toBeGreaterThan(1);
    // Manifest entries match the sealed chunk metadata (rangess line up).
    for (let i = 1; i < list.length; i++) {
      expect(list[i - 1]?.toBlock).toBe(list[i]?.fromBlock);
    }
    expect(list[0]?.fromBlock).toBe("0x64");
    expect(list[list.length - 1]?.toBlock).toBe("0xc8");
  });

  it("dry-run writes nothing to disk", async () => {
    await processStream(asyncLines(event(0x65n), event(0x66n)), {
      ...baseArgs(dir),
      sizeLimit: 1024,
      dryRun: true,
    });
    expect(existsSync(join(dir, "index.json"))).toBe(false);
    expect(readdirSync(dir).filter((f) => f.endsWith(".gz"))).toEqual([]);
  });

  it("ignores blank lines in the input stream", async () => {
    async function* withBlanks(): AsyncGenerator<string> {
      yield "";
      yield JSON.stringify(event(0x65n));
      yield "   ";
      yield JSON.stringify(event(0x66n));
    }
    const { sealed } = await processStream(withBlanks(), {
      ...baseArgs(dir),
      sizeLimit: 10_000,
    });
    expect(sealed).toHaveLength(1);
  });

  it("suspend mode returns the trailing accumulator instead of sealing it", async () => {
    const result = await processStream(asyncLines(event(0x65n), event(0x66n)), {
      ...baseArgs(dir),
      sizeLimit: 10_000,
      trailingMode: "suspend",
    });
    expect(result.sealed).toHaveLength(0); // nothing sealed mid-stream (under size limit)
    expect(result.trailing).toBeDefined();
    expect(result.trailing!.events).toHaveLength(2);
    expect(result.trailing!.fromBlock).toBe(0x64n);
    expect(result.trailing!.toBlock).toBe(0xc8n);
  });

  it("suspend mode returns empty trailing when scrape produced no events", async () => {
    const result = await processStream(asyncLines(), {
      ...baseArgs(dir),
      sizeLimit: 10_000,
      trailingMode: "suspend",
    });
    expect(result.sealed).toHaveLength(0);
    expect(result.trailing).toBeDefined();
    expect(result.trailing!.events).toHaveLength(0);
    expect(result.trailing!.fromBlock).toBe(0x64n);
    expect(result.trailing!.toBlock).toBe(0xc8n);
  });

  it("seed pre-loads the accumulator and the first sealed chunk starts at seed.chunkFrom", async () => {
    const big = "x".repeat(200);
    // Seed has 2 events at blocks 0x50, 0x51 (before this batch's fromBlock=0x64).
    const seed = {
      events: [event(0x50n, 0, big), event(0x51n, 0, big)],
      chunkFrom: 0x40n,
    };
    // New scrape events at 0x65, 0x66 (in [0x64, 0xc8)).
    const result = await processStream(asyncLines(event(0x65n, 0, big), event(0x66n, 0, big)), {
      ...baseArgs(dir),
      sizeLimit: 600,
      seed,
      trailingMode: "suspend",
    });
    // Seed + new events ≈ 1000 bytes > 600 → at least one seal triggers.
    expect(result.sealed.length).toBeGreaterThanOrEqual(1);
    // The first sealed chunk's fromBlock must be the seed.chunkFrom, not the
    // batch's fromBlock.
    expect(result.sealed[0]?.fromBlock).toBe("0x40");
  });

  it("seed events bypass the range check (they're typically before fromBlock)", async () => {
    // If range check were enforced on seed, block 0x50 would throw (it's
    // below fromBlock=0x64). Suspend mode + seed should accept it.
    const result = await processStream(asyncLines(), {
      ...baseArgs(dir),
      sizeLimit: 10_000,
      seed: { events: [event(0x50n)], chunkFrom: 0x40n },
      trailingMode: "suspend",
    });
    expect(result.trailing!.events).toHaveLength(1);
  });
});
