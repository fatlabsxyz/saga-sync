import { describe, it, expect } from "vitest";
import { assertChainId, finalizedBlock } from "./cli.js";

describe("finalizedBlock", () => {
  it("returns the finalized block number", async () => {
    const client = { getBlock: async () => ({ number: 0x1234n }) } as any;
    expect(await finalizedBlock(client)).toBe(0x1234n);
  });

  it("returns null when the RPC rejects the finalized tag", async () => {
    const client = {
      getBlock: async () => {
        throw new Error("unknown block tag: finalized");
      },
    } as any;
    expect(await finalizedBlock(client)).toBeNull();
  });
});

describe("assertChainId", () => {
  it("resolves when the RPC chain matches the config", async () => {
    const client = { getChainId: async () => 1 } as any;
    await expect(assertChainId(client, "0x1")).resolves.toBeUndefined();
  });

  it("throws when the RPC is on a different chain", async () => {
    const client = { getChainId: async () => 137 } as any;
    await expect(assertChainId(client, "0x1")).rejects.toThrow(/chain mismatch/);
  });
});
