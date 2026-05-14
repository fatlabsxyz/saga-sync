import { describe, it, expect } from "vitest";
import { finalizedBlock } from "./cli.js";

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
