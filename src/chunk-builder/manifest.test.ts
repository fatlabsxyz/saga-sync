import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DiskStore } from "../storage/disk-store.js";
import { Manifest } from "./manifest.js";
import type { ChunkMeta } from "./manifest.js";

const meta = (overrides: Partial<ChunkMeta> = {}): ChunkMeta => ({
  fromBlock: "0xc50101",
  toBlock: "0xc50200",
  file: "proto-[0xc50101,0xc50200).jsonl.gz",
  size: "0x1a2",
  digest: { type: "blake3", data: "0xabcd" },
  ...overrides,
});

describe("Manifest", () => {
  let dir: string;
  let store: DiskStore;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "manifest-test-"));
    store = new DiskStore(dir);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("loads an empty manifest when index.json is absent", async () => {
    const m = await Manifest.load(store);
    expect(m.snapshot()).toEqual({ availableStates: {} });
  });

  it("appendChunk persists and is readable on reload", async () => {
    const m = await Manifest.load(store);
    await m.appendChunk("proto-a", meta());
    const reloaded = await Manifest.load(store);
    expect(reloaded.sealedChunks("proto-a")).toEqual([meta()]);
  });

  it("appendChunk extends the array in order", async () => {
    const m = await Manifest.load(store);
    await m.appendChunk("proto-a", meta({ fromBlock: "0x1" }));
    await m.appendChunk("proto-a", meta({ fromBlock: "0x2" }));
    await m.appendChunk("proto-a", meta({ fromBlock: "0x3" }));
    expect(m.sealedChunks("proto-a").map((c) => c.fromBlock)).toEqual(["0x1", "0x2", "0x3"]);
  });

  it("setHotHead stores one mutable entry per protocol; clearHotHead removes it", async () => {
    const m = await Manifest.load(store);
    await m.setHotHead("proto-a", meta({ toBlock: "0x100" }));
    await m.setHotHead("proto-a", meta({ toBlock: "0x200" })); // replaces
    expect(m.hotHead("proto-a")?.toBlock).toBe("0x200");
    await m.clearHotHead("proto-a");
    expect(m.hotHead("proto-a")).toBeUndefined();
  });

  it("setHotHead does not disturb availableStates", async () => {
    const m = await Manifest.load(store);
    await m.appendChunk("proto-a", meta({ toBlock: "0xfff" }));
    await m.setHotHead("proto-a", meta({ toBlock: "0x100" }));
    expect(m.sealedChunks("proto-a")).toHaveLength(1);
    expect(m.sealedChunks("proto-a")[0]?.toBlock).toBe("0xfff");
  });

  it("clearHotHead drops the hotHeads field once empty", async () => {
    const m = await Manifest.load(store);
    await m.setHotHead("proto-a", meta());
    await m.clearHotHead("proto-a");
    expect(await Manifest.load(store).then((x) => x.snapshot().hotHeads)).toBeUndefined();
  });

  it("throws on a corrupt manifest rather than silently resetting", async () => {
    writeFileSync(join(dir, "index.json"), "{ not valid json", "utf8");
    await expect(Manifest.load(store)).rejects.toThrow();
  });

  describe("lastCoveredBlock", () => {
    it("is null with neither sealed chunks nor a hot head", async () => {
      const m = await Manifest.load(store);
      expect(m.lastCoveredBlock("proto")).toBeNull();
    });

    it("is the last sealed chunk's toBlock when there is no hot head", async () => {
      const m = await Manifest.load(store);
      await m.appendChunk("proto", meta({ toBlock: "0x10" }));
      await m.appendChunk("proto", meta({ toBlock: "0x30" }));
      expect(m.lastCoveredBlock("proto")).toBe(0x30n);
    });

    it("is the hot head's toBlock when it leads the sealed chunks", async () => {
      const m = await Manifest.load(store);
      await m.appendChunk("proto", meta({ toBlock: "0x20" }));
      await m.setHotHead("proto", meta({ toBlock: "0x50" }));
      expect(m.lastCoveredBlock("proto")).toBe(0x50n);
    });

    it("is the sealed toBlock when the hot head is stale (behind sealed)", async () => {
      const m = await Manifest.load(store);
      await m.appendChunk("proto", meta({ toBlock: "0x50" }));
      await m.setHotHead("proto", meta({ toBlock: "0x30" }));
      expect(m.lastCoveredBlock("proto")).toBe(0x50n);
    });
  });
});
