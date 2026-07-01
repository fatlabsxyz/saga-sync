import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CanonicalEvent } from "../scraper/normalize.js";
import { DiskStore } from "@saga-sync/core/node";
import { DryRunStore } from "../storage/dry-run-store.js";
import { ChunkArchive } from "./archive.js";
import { Manifest } from "@saga-sync/core";
import { processStream, type ProcessArgs } from "./cli.js";

const event = (block: bigint, logIndex = 0, padding = ""): CanonicalEvent => ({
  contractAddress: "0x12d66f87a04a9e220743712ce6d9bb1b5616b8fc",
  eventTopic: "0xa945e51eec50ab98c161376f0db4cf2aeba3ec92755fe2fcd388bdbbb80ff196",
  topics: ["0xa945e51eec50ab98c161376f0db4cf2aeba3ec92755fe2fcd388bdbbb80ff196"],
  data: `0x${"00".repeat(padding.length)}` as `0x${string}`,
  blockNumber: `0x${block.toString(16)}` as `0x${string}`,
  logIndex: `0x${logIndex.toString(16)}` as `0x${string}`,
});

async function* asyncLines(...events: CanonicalEvent[]): AsyncGenerator<string> {
  for (const e of events) yield JSON.stringify(e);
}

// Builds a ProcessArgs over a temp DiskStore (or DryRunStore when dryRun).
async function makeArgs(
  dir: string,
  sizeLimit: number,
  dryRun = false,
): Promise<ProcessArgs & { manifest: Manifest }> {
  const store = dryRun ? new DryRunStore(new DiskStore(dir)) : new DiskStore(dir);
  const archive = new ChunkArchive(store);
  const manifest = await Manifest.load(store);
  return { protocolId: "proto", fromBlock: 0x64n, toBlock: 0xc8n, sizeLimit, archive, manifest };
}

describe("processStream", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "chunk-cli-test-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("emits one empty chunk covering the full range when stdin is empty", async () => {
    const args = await makeArgs(dir, 1024);
    const { sealed } = await processStream(asyncLines(), args);
    expect(sealed).toHaveLength(1);
    expect(sealed[0]?.fromBlock).toBe("0x64");
    expect(sealed[0]?.toBlock).toBe("0xc8");
    expect(args.manifest.sealedChunks("proto")).toHaveLength(1);
  });

  it("emits one chunk when all events fit under the size limit", async () => {
    const args = await makeArgs(dir, 10_000);
    const { sealed } = await processStream(
      asyncLines(event(0x65n), event(0x66n), event(0x67n)),
      args,
    );
    expect(sealed).toHaveLength(1);
    expect(sealed[0]?.fromBlock).toBe("0x64");
    expect(sealed[0]?.toBlock).toBe("0xc8");
  });

  it("splits at a block boundary when the limit would be exceeded", async () => {
    const big = "x".repeat(200);
    const { sealed } = await processStream(
      asyncLines(
        event(0x65n, 0, big),
        event(0x65n, 1, big),
        event(0x66n, 0, big),
        event(0x66n, 1, big),
      ),
      await makeArgs(dir, 600),
    );
    expect(sealed).toHaveLength(2);
    expect(sealed[0]?.toBlock).toBe(sealed[1]?.fromBlock);
    expect(sealed[0]?.fromBlock).toBe("0x64");
    expect(sealed[1]?.toBlock).toBe("0xc8");
  });

  it("never splits events within the same block, even if oversized", async () => {
    const big = "x".repeat(200);
    const { sealed } = await processStream(
      asyncLines(
        event(0x65n, 0, big),
        event(0x65n, 1, big),
        event(0x65n, 2, big),
        event(0x65n, 3, big),
        event(0x66n, 0, big),
      ),
      await makeArgs(dir, 400),
    );
    expect(sealed).toHaveLength(2);
    expect(sealed[0]?.fromBlock).toBe("0x64");
    expect(sealed[0]?.toBlock).toBe("0x66");
    expect(sealed[1]?.fromBlock).toBe("0x66");
    expect(sealed[1]?.toBlock).toBe("0xc8");
  });

  it("rejects events outside the scanned range", async () => {
    await expect(
      processStream(asyncLines(event(0x32n)), await makeArgs(dir, 1024)),
    ).rejects.toThrow(/outside scanned range/);
  });

  it("rejects events at or after --to-block (half-open upper)", async () => {
    await expect(
      processStream(asyncLines(event(0xc8n)), await makeArgs(dir, 1024)),
    ).rejects.toThrow(/outside scanned range/);
  });

  it("updates the manifest with one entry per sealed chunk", async () => {
    const big = "x".repeat(200);
    const args = await makeArgs(dir, 300);
    await processStream(
      asyncLines(event(0x65n, 0, big), event(0x66n, 0, big), event(0x67n, 0, big)),
      args,
    );
    const list = args.manifest.sealedChunks("proto");
    expect(list.length).toBeGreaterThan(1);
    for (let i = 1; i < list.length; i++) {
      expect(list[i - 1]?.toBlock).toBe(list[i]?.fromBlock);
    }
    expect(list[0]?.fromBlock).toBe("0x64");
    expect(list[list.length - 1]?.toBlock).toBe("0xc8");
  });

  it("dry-run (DryRunStore) writes nothing to disk", async () => {
    await processStream(
      asyncLines(event(0x65n), event(0x66n)),
      await makeArgs(dir, 1024, true),
    );
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
    const { sealed } = await processStream(withBlanks(), await makeArgs(dir, 10_000));
    expect(sealed).toHaveLength(1);
  });

  it("suspend mode returns the trailing accumulator instead of sealing it", async () => {
    const result = await processStream(asyncLines(event(0x65n), event(0x66n)), {
      ...(await makeArgs(dir, 10_000)),
      trailingMode: "suspend",
    });
    expect(result.sealed).toHaveLength(0);
    expect(result.trailing).toBeDefined();
    expect(result.trailing!.events).toHaveLength(2);
    expect(result.trailing!.fromBlock).toBe(0x64n);
    expect(result.trailing!.toBlock).toBe(0xc8n);
  });

  it("suspend mode returns empty trailing when scrape produced no events", async () => {
    const result = await processStream(asyncLines(), {
      ...(await makeArgs(dir, 10_000)),
      trailingMode: "suspend",
    });
    expect(result.sealed).toHaveLength(0);
    expect(result.trailing!.events).toHaveLength(0);
    expect(result.trailing!.fromBlock).toBe(0x64n);
    expect(result.trailing!.toBlock).toBe(0xc8n);
  });

  it("seed pre-loads the accumulator; first sealed chunk starts at seed.chunkFrom", async () => {
    const big = "x".repeat(200);
    const result = await processStream(asyncLines(event(0x65n, 0, big), event(0x66n, 0, big)), {
      ...(await makeArgs(dir, 600)),
      seed: { events: [event(0x50n, 0, big), event(0x51n, 0, big)], chunkFrom: 0x40n },
      trailingMode: "suspend",
    });
    expect(result.sealed.length).toBeGreaterThanOrEqual(1);
    expect(result.sealed[0]?.fromBlock).toBe("0x40");
  });

  it("seed events bypass the range check", async () => {
    const result = await processStream(asyncLines(), {
      ...(await makeArgs(dir, 10_000)),
      seed: { events: [event(0x50n)], chunkFrom: 0x40n },
      trailingMode: "suspend",
    });
    expect(result.trailing!.events).toHaveLength(1);
  });
});
