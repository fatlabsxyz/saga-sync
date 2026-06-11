import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DiskStore } from "../storage/disk-store.js";
import { Manifest } from "./manifest.js";
import type { ChunkMeta } from "./manifest.js";
import { generateKeyPair, signManifest, verifyManifestSignature } from "../signing.js";

const meta = (overrides: Partial<ChunkMeta> = {}): ChunkMeta => ({
  fromBlock: "0xc50101",
  toBlock: "0xc50200",
  file: "proto-[0xc50101,0xc50200).jsonl.gz",
  size: "0x1a2",
  digest: { type: "sha256", data: "0xabcd" },
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
    expect(m.snapshot()).toEqual({ version: 1, compression: "gzip", availableStates: {} });
  });

  it("stamps version, compression and a fresh updatedAt on persist", async () => {
    const before = Date.now();
    const m = await Manifest.load(store);
    await m.appendChunk("proto", meta());
    const reloaded = (await Manifest.load(store)).snapshot();
    expect(reloaded.version).toBe(1);
    expect(reloaded.compression).toBe("gzip");
    expect(reloaded.updatedAt).toBeTypeOf("string");
    expect(new Date(reloaded.updatedAt!).getTime()).toBeGreaterThanOrEqual(before);
  });

  it("rejects a manifest declaring a newer version rather than misparsing it", async () => {
    writeFileSync(
      join(dir, "index.json"),
      JSON.stringify({ version: 2, compression: "gzip", availableStates: {} }),
      "utf8",
    );
    await expect(Manifest.load(store)).rejects.toThrow(/unsupported version 2/);
  });

  it("treats a version-less (legacy) manifest as v1", async () => {
    writeFileSync(
      join(dir, "index.json"),
      JSON.stringify({ availableStates: { proto: [meta()] } }),
      "utf8",
    );
    const m = await Manifest.load(store);
    expect(m.version()).toBe(1);
    expect(m.sealedChunks("proto")).toEqual([meta()]);
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

  describe("protocolIds", () => {
    it("is empty for an empty manifest", async () => {
      const m = await Manifest.load(store);
      expect(m.protocolIds()).toEqual([]);
    });

    it("unions sealed and hot-head protocols, sorted and deduped", async () => {
      const m = await Manifest.load(store);
      await m.appendChunk("proto-b", meta());
      await m.appendChunk("proto-a", meta());
      await m.setHotHead("proto-a", meta()); // dup of a sealed one
      await m.setHotHead("proto-c", meta()); // hot-head-only protocol
      expect(m.protocolIds()).toEqual(["proto-a", "proto-b", "proto-c"]);
    });
  });

  describe("firstCoveredBlock", () => {
    it("is null for an unknown protocol", async () => {
      const m = await Manifest.load(store);
      expect(m.firstCoveredBlock("proto")).toBeNull();
    });

    it("is the first sealed chunk's fromBlock", async () => {
      const m = await Manifest.load(store);
      await m.appendChunk("proto", meta({ fromBlock: "0x10", toBlock: "0x20" }));
      await m.appendChunk("proto", meta({ fromBlock: "0x20", toBlock: "0x30" }));
      expect(m.firstCoveredBlock("proto")).toBe(0x10n);
    });

    it("falls back to the hot head when nothing has sealed yet", async () => {
      const m = await Manifest.load(store);
      await m.setHotHead("proto", meta({ fromBlock: "0x40" }));
      expect(m.firstCoveredBlock("proto")).toBe(0x40n);
    });
  });

  describe("gaps", () => {
    it("is empty for a gapless chain", async () => {
      const m = await Manifest.load(store);
      await m.appendChunk("proto", meta({ fromBlock: "0x0", toBlock: "0x10" }));
      await m.appendChunk("proto", meta({ fromBlock: "0x10", toBlock: "0x20" }));
      await m.appendChunk("proto", meta({ fromBlock: "0x20", toBlock: "0x30" }));
      expect(m.gaps("proto")).toEqual([]);
    });

    it("reports each hole as the missing [prev.toBlock, next.fromBlock) range", async () => {
      const m = await Manifest.load(store);
      await m.appendChunk("proto", meta({ fromBlock: "0x0", toBlock: "0x10" }));
      await m.appendChunk("proto", meta({ fromBlock: "0x20", toBlock: "0x30" })); // hole [0x10,0x20)
      await m.appendChunk("proto", meta({ fromBlock: "0x30", toBlock: "0x40" }));
      await m.appendChunk("proto", meta({ fromBlock: "0x50", toBlock: "0x60" })); // hole [0x40,0x50)
      expect(m.gaps("proto")).toEqual([
        { from: "0x10", to: "0x20" },
        { from: "0x40", to: "0x50" },
      ]);
    });

    it("is empty for fewer than two chunks", async () => {
      const m = await Manifest.load(store);
      expect(m.gaps("proto")).toEqual([]);
      await m.appendChunk("proto", meta());
      expect(m.gaps("proto")).toEqual([]);
    });
  });

  describe("signing", () => {
    it("writes index.json.sig with a valid signature when a signer is set", async () => {
      const { secretKey, publicKey } = generateKeyPair();
      const m = await Manifest.load(store, undefined, {
        signer: (bytes) => signManifest(bytes, secretKey),
      });
      await m.appendChunk("proto", meta());

      const manifestBytes = await store.get("index.json");
      const sig = await store.get("index.json.sig");
      expect(manifestBytes).not.toBeNull();
      expect(sig).not.toBeNull();
      expect(() =>
        verifyManifestSignature(manifestBytes!, sig!.toString("utf8").trim(), publicKey),
      ).not.toThrow();
    });

    it("does not write a signature when no signer is set", async () => {
      const m = await Manifest.load(store);
      await m.appendChunk("proto", meta());
      expect(await store.get("index.json.sig")).toBeNull();
    });

    it("re-signs on every persist (signature tracks the current manifest)", async () => {
      const { secretKey, publicKey } = generateKeyPair();
      const m = await Manifest.load(store, undefined, {
        signer: (bytes) => signManifest(bytes, secretKey),
      });
      await m.appendChunk("proto", meta({ toBlock: "0x10" }));
      await m.appendChunk("proto", meta({ toBlock: "0x20" }));
      const manifestBytes = await store.get("index.json");
      const sig = await store.get("index.json.sig");
      expect(() =>
        verifyManifestSignature(manifestBytes!, sig!.toString("utf8").trim(), publicKey),
      ).not.toThrow();
    });
  });
});
