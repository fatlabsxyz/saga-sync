import { describe, it, expect } from "vitest";
import type { RpcLog } from "viem";
import { normalize } from "./normalize.js";

const baseLog = (overrides: Partial<RpcLog> = {}): RpcLog =>
  ({
    address: "0xAbC0000000000000000000000000000000000001",
    topics: [
      "0xAAA0000000000000000000000000000000000000000000000000000000000001",
      "0xBBB0000000000000000000000000000000000000000000000000000000000002",
    ],
    data: "0xDEADBEEF",
    blockNumber: "0x1A2B",
    blockHash: "0xCCC0000000000000000000000000000000000000000000000000000000000003",
    transactionHash: "0xDDD0000000000000000000000000000000000000000000000000000000000004",
    transactionIndex: "0x5",
    logIndex: "0x7",
    removed: false,
    ...overrides,
  }) as RpcLog;

describe("normalize", () => {
  it("lowercases all hex fields", () => {
    const e = normalize(baseLog());
    expect(e.contractAddress).toBe("0xabc0000000000000000000000000000000000001");
    expect(e.eventTopic).toBe(
      "0xaaa0000000000000000000000000000000000000000000000000000000000001",
    );
    expect(e.topics).toEqual([
      "0xaaa0000000000000000000000000000000000000000000000000000000000001",
      "0xbbb0000000000000000000000000000000000000000000000000000000000002",
    ]);
    expect(e.data).toBe("0xdeadbeef");
    expect(e.transactionHash).toBe(
      "0xddd0000000000000000000000000000000000000000000000000000000000004",
    );
    expect(e.blockHash).toBe(
      "0xccc0000000000000000000000000000000000000000000000000000000000003",
    );
  });

  it("keeps blockNumber and logIndex as 0x hex", () => {
    const e = normalize(baseLog());
    expect(e.blockNumber).toBe("0x1a2b");
    expect(e.logIndex).toBe("0x7");
  });

  it("sets eventTopic to topics[0]", () => {
    const e = normalize(baseLog());
    expect(e.eventTopic).toBe(e.topics[0]);
  });

  it("throws on a log with no topics", () => {
    expect(() => normalize(baseLog({ topics: [] }))).toThrow(/without topics/);
  });

  it("throws on a pending log (null block fields)", () => {
    expect(() => normalize(baseLog({ blockNumber: null }))).toThrow(/pending/);
  });
});
