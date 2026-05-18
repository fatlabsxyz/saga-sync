import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { runProtocolOnce } from "./pipeline.js";
import type { EventFilter } from "../scraper/config.js";

const filter: EventFilter = {
  contractAddress: `0x${"a".repeat(40)}` as `0x${string}`,
  eventTopic: `0x${"b".repeat(64)}` as `0x${string}`,
};

const log = (block: string, logIndex: string) => ({
  address: filter.contractAddress,
  topics: [filter.eventTopic],
  data: "0x",
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
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "orch-pipeline-test-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("composes scrape → chunk and seals one chunk for events under the size limit", async () => {
    const client = fakeClient(async () => [log("0x10", "0x0"), log("0x11", "0x0")]);
    const sealed = await runProtocolOnce({
      client,
      protocolId: "proto",
      fromBlock: 0x10n,
      toBlock: 0x20n,
      events: [filter],
      sizeLimit: 100_000,
      outputDir: dir,
      window: 100,
    });
    expect(sealed).toHaveLength(1);
    expect(sealed[0]?.fromBlock).toBe("0x10");
    expect(sealed[0]?.toBlock).toBe("0x21"); // inclusive 0x20 → half-open 0x21
    expect(existsSync(join(dir, sealed[0]!.file))).toBe(true);
  });

  it("seals an empty chunk when the scrape returns no events", async () => {
    const client = fakeClient(async () => []);
    const sealed = await runProtocolOnce({
      client,
      protocolId: "proto",
      fromBlock: 0x10n,
      toBlock: 0x20n,
      events: [filter],
      sizeLimit: 100_000,
      outputDir: dir,
      window: 100,
    });
    expect(sealed).toHaveLength(1);
    const decompressed = gunzipSync(readFileSync(join(dir, sealed[0]!.file)));
    expect(decompressed.length).toBe(0);
    // Well-known empty-input blake3.
    expect(sealed[0]?.digest.data).toBe(
      "0xaf1349b9f5f9a1a6a0404dea36dcc9499bcb25c9adc112b7cc9a93cae41f3262",
    );
  });

  it("splits at block boundaries when the size limit is exceeded", async () => {
    const big = `0x${"f".repeat(800)}`;
    const client = fakeClient(async ({ params }: any) => {
      // Return one event per block in the requested window.
      const from = BigInt(params[0].fromBlock);
      const to = BigInt(params[0].toBlock);
      const out: any[] = [];
      for (let b = from; b <= to; b += 1n) {
        out.push({ ...log(`0x${b.toString(16)}`, "0x0"), data: big });
      }
      return out;
    });
    const sealed = await runProtocolOnce({
      client,
      protocolId: "proto",
      fromBlock: 0x10n,
      toBlock: 0x13n,
      events: [filter],
      sizeLimit: 1000,
      outputDir: dir,
      window: 100,
    });
    expect(sealed.length).toBeGreaterThan(1);
    // Chunks compose: chunk N's toBlock equals chunk N+1's fromBlock.
    for (let i = 1; i < sealed.length; i++) {
      expect(sealed[i - 1]?.toBlock).toBe(sealed[i]?.fromBlock);
    }
    expect(sealed[0]?.fromBlock).toBe("0x10");
    expect(sealed[sealed.length - 1]?.toBlock).toBe("0x14");
  });
});
