import { describe, it, expect } from "vitest";
import { scrape } from "./scrape.js";
import type { EventFilter } from "./config.js";

const filter: EventFilter = {
  contractAddress: `0x${"a".repeat(40)}` as `0x${string}`,
  eventTopic: `0x${"b".repeat(64)}` as `0x${string}`,
};

const fakeClient = (request: (args: any) => Promise<any>) => ({ request }) as any;

async function collect<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of gen) out.push(x);
  return out;
}

describe("scrape", () => {
  it("slices the block range into windows", async () => {
    const calls: Array<{ from: string; to: string }> = [];
    const client = fakeClient(async ({ params }) => {
      calls.push({ from: params[0].fromBlock, to: params[0].toBlock });
      return [];
    });
    await collect(
      scrape(client, { fromBlock: 0n, toBlock: 12n, events: [filter], window: 5 }),
    );
    expect(calls).toEqual([
      { from: "0x0", to: "0x4" },
      { from: "0x5", to: "0x9" },
      { from: "0xa", to: "0xc" },
    ]);
  });

  it("queries every event filter for each window", async () => {
    let count = 0;
    const client = fakeClient(async () => {
      count += 1;
      return [];
    });
    await collect(
      scrape(client, {
        fromBlock: 0n,
        toBlock: 9n,
        events: [filter, filter, filter],
        window: 100,
      }),
    );
    expect(count).toBe(3); // one window, three filters
  });

  it("halves the window and retries on a range error", async () => {
    const seen: Array<{ from: string; to: string }> = [];
    const client = fakeClient(async ({ params }) => {
      const from = params[0].fromBlock;
      const to = params[0].toBlock;
      seen.push({ from, to });
      if (from === "0x0" && to === "0x9") {
        throw new Error("query returned more than 10000 results");
      }
      return [];
    });
    await collect(
      scrape(client, { fromBlock: 0n, toBlock: 9n, events: [filter], window: 10 }),
    );
    expect(seen[0]).toEqual({ from: "0x0", to: "0x9" });
    expect(seen.slice(1)).toEqual([
      { from: "0x0", to: "0x4" },
      { from: "0x5", to: "0x9" },
    ]);
  });

  it("yields logs sorted by (blockNumber, logIndex)", async () => {
    const client = fakeClient(async () => [
      { blockNumber: "0x2", logIndex: "0x0" },
      { blockNumber: "0x1", logIndex: "0x5" },
      { blockNumber: "0x1", logIndex: "0x1" },
    ]);
    const logs = await collect(
      scrape(client, { fromBlock: 0n, toBlock: 0n, events: [filter], window: 10 }),
    );
    expect(logs.map((l: any) => `${l.blockNumber}:${l.logIndex}`)).toEqual([
      "0x1:0x1",
      "0x1:0x5",
      "0x2:0x0",
    ]);
  });

  it("re-throws errors that are not range errors", async () => {
    const client = fakeClient(async () => {
      throw new Error("connection refused");
    });
    await expect(
      collect(scrape(client, { fromBlock: 0n, toBlock: 5n, events: [filter], window: 10 })),
    ).rejects.toThrow(/connection refused/);
  });
});
