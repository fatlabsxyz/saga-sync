import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CanonicalEvent } from "../scraper/normalize.js";
import type { EventFilter } from "../scraper/config.js";
import { DiskStore } from "../storage/disk-store.js";
import { ChunkArchive } from "../chunk-builder/archive.js";
import { Manifest } from "../chunk-builder/manifest.js";
import { runProtocolOnce } from "./pipeline.js";

const filter: EventFilter = {
  contractAddress: `0x${"a".repeat(40)}` as `0x${string}`,
  eventTopic: `0x${"b".repeat(64)}` as `0x${string}`,
};

const log = (block: string, logIndex: string, data = "0x") => ({
  address: filter.contractAddress,
  topics: [filter.eventTopic],
  data,
  blockNumber: block,
  blockHash: `0x${"c".repeat(64)}`,
  transactionHash: `0x${"d".repeat(64)}`,
  transactionIndex: "0x0",
  logIndex,
  removed: false,
});

const fakeClient = (request: (args: any) => Promise<any>) => ({ request }) as any;

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
    const client = fakeClient(async () => [log("0x10", "0x0"), log("0x11", "0x0")]);
    const { sealed } = await runProtocolOnce({
      client,
      protocolId: "proto",
      fromBlock: 0x10n,
      toBlock: 0x20n,
      events: [filter],
      sizeLimit: 100_000,
      window: 100,
      archive,
      manifest,
    });
    expect(sealed).toHaveLength(1);
    expect(sealed[0]?.fromBlock).toBe("0x10");
    expect(sealed[0]?.toBlock).toBe("0x21"); // inclusive 0x20 → half-open 0x21
    expect(await archive.readEvents(sealed[0]!)).toHaveLength(2);
  });

  it("seals an empty chunk when the scrape returns no events", async () => {
    const client = fakeClient(async () => []);
    const { sealed } = await runProtocolOnce({
      client,
      protocolId: "proto",
      fromBlock: 0x10n,
      toBlock: 0x20n,
      events: [filter],
      sizeLimit: 100_000,
      window: 100,
      archive,
      manifest,
    });
    expect(sealed).toHaveLength(1);
    expect(await archive.readEvents(sealed[0]!)).toEqual([]);
    expect(sealed[0]?.digest.data).toBe(
      "0xaf1349b9f5f9a1a6a0404dea36dcc9499bcb25c9adc112b7cc9a93cae41f3262",
    );
  });

  it("splits at block boundaries when the size limit is exceeded", async () => {
    const big = `0x${"f".repeat(800)}`;
    const client = fakeClient(async ({ params }: any) => {
      const from = BigInt(params[0].fromBlock);
      const to = BigInt(params[0].toBlock);
      const out: any[] = [];
      for (let b = from; b <= to; b += 1n) out.push(log(`0x${b.toString(16)}`, "0x0", big));
      return out;
    });
    const { sealed } = await runProtocolOnce({
      client,
      protocolId: "proto",
      fromBlock: 0x10n,
      toBlock: 0x13n,
      events: [filter],
      sizeLimit: 1000,
      window: 100,
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
    const client = fakeClient(async () => [log("0x10", "0x0"), log("0x11", "0x0")]);
    const result = await runProtocolOnce({
      client,
      protocolId: "proto",
      fromBlock: 0x10n,
      toBlock: 0x20n,
      events: [filter],
      sizeLimit: 100_000,
      window: 100,
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
    const client = fakeClient(async ({ params }: any) => {
      const from = BigInt(params[0].fromBlock);
      const to = BigInt(params[0].toBlock);
      const out: any[] = [];
      for (let b = from; b <= to; b += 1n) out.push(log(`0x${b.toString(16)}`, "0x0", big));
      return out;
    });
    const ev = (block: string): CanonicalEvent => ({
      contractAddress: filter.contractAddress,
      eventTopic: filter.eventTopic,
      topics: [filter.eventTopic],
      data: big as `0x${string}`,
      blockNumber: block as `0x${string}`,
      logIndex: "0x0",
      transactionHash: "0xdd",
      blockHash: "0xcc",
    });
    const result = await runProtocolOnce({
      client,
      protocolId: "proto",
      fromBlock: 0x10n,
      toBlock: 0x13n,
      events: [filter],
      sizeLimit: 1000,
      window: 100,
      archive,
      manifest,
      hotHead: { events: [ev("0x5"), ev("0x6")], fromBlock: 0x0n },
      trailingMode: "suspend",
    });
    expect(result.sealed.length).toBeGreaterThanOrEqual(1);
    // First sealed chunk starts at the hot-head's fromBlock, not the batch fromBlock.
    expect(result.sealed[0]?.fromBlock).toBe("0x0");
  });
});
