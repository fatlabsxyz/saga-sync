import { describe, it, expect, beforeEach } from "vitest";
import type { CanonicalEvent } from "../scraper/normalize.js";
import type { Store } from "../storage/store.js";
import { ChunkArchive } from "../chunk-builder/archive.js";
import { Manifest } from "../chunk-builder/manifest.js";
import { Client } from "./client.js";
import { cmdProtocols, cmdInfo, cmdHead, cmdChunks } from "./cli.js";

// Minimal in-memory store — the query commands only ever `get`.
class MemStore implements Store {
  readonly data = new Map<string, Buffer>();
  async get(key: string): Promise<Buffer | null> {
    return this.data.get(key) ?? null;
  }
  async put(key: string, data: Buffer): Promise<void> {
    this.data.set(key, Buffer.from(data));
  }
  async delete(key: string): Promise<void> {
    this.data.delete(key);
  }
  async list(prefix: string): Promise<string[]> {
    return [...this.data.keys()].filter((k) => k.startsWith(prefix));
  }
}

const event = (block: bigint): CanonicalEvent => ({
  contractAddress: "0x12d66f87a04a9e220743712ce6d9bb1b5616b8fc",
  eventTopic: "0xa945e51eec50ab98c161376f0db4cf2aeba3ec92755fe2fcd388bdbbb80ff196",
  topics: ["0xa945e51eec50ab98c161376f0db4cf2aeba3ec92755fe2fcd388bdbbb80ff196"],
  data: "0x",
  blockNumber: `0x${block.toString(16)}`,
  logIndex: "0x0",
  transactionHash: "0xaa",
  blockHash: "0xbb",
});

// Seal sealed chunks (+ optional hot head) for a protocol into the store.
async function publish(
  store: Store,
  protocolId: string,
  sealed: { from: bigint; to: bigint }[],
  hot?: { from: bigint; to: bigint },
): Promise<void> {
  const archive = new ChunkArchive(store);
  const manifest = await Manifest.load(store);
  for (const r of sealed) {
    const meta = await archive.seal(protocolId, [event(r.from)], { from: r.from, to: r.to });
    await manifest.appendChunk(protocolId, meta);
  }
  if (hot) {
    const meta = await archive.writeHotHead(protocolId, [event(hot.from)], {
      from: hot.from,
      to: hot.to,
    });
    await manifest.setHotHead(protocolId, meta);
  }
}

describe("client CLI handlers", () => {
  let source: MemStore;
  let client: Client;
  beforeEach(() => {
    source = new MemStore();
    client = new Client({ source });
  });

  describe("protocols", () => {
    it("lists every protocol with summary fields (json)", async () => {
      await publish(source, "proto-b", [{ from: 0n, to: 0x10n }]);
      await publish(source, "proto-a", [{ from: 0n, to: 0x10n }], { from: 0x10n, to: 0x18n });
      const out = JSON.parse(await cmdProtocols(client, { json: true }));
      expect(out.map((r: { protocolId: string }) => r.protocolId)).toEqual(["proto-a", "proto-b"]);
      const a = out.find((r: { protocolId: string }) => r.protocolId === "proto-a");
      expect(a).toMatchObject({ sealedChunks: 1, fromBlock: "0x0", lastCoveredBlock: "0x18", hotHead: true });
      expect(a.totalSize).toMatch(/^0x[0-9a-f]+$/);
    });

    it("notes a present-but-empty manifest", async () => {
      source.data.set("index.json", Buffer.from('{"availableStates":{}}\n', "utf8"));
      expect(await cmdProtocols(client, { json: false })).toBe("(no protocols in manifest)");
    });

    it("renders a table in human mode", async () => {
      await publish(source, "proto-a", [{ from: 0n, to: 0x10n }]);
      const human = await cmdProtocols(client, { json: false });
      expect(human).toContain("PROTOCOL");
      expect(human).toContain("proto-a");
    });
  });

  describe("info", () => {
    it("summarizes range, size, hot head and gapless contiguity (json)", async () => {
      await publish(
        source,
        "p",
        [
          { from: 0n, to: 0x10n },
          { from: 0x10n, to: 0x20n },
        ],
        { from: 0x20n, to: 0x28n },
      );
      const out = JSON.parse(await cmdInfo(client, "p", { json: true }));
      expect(out).toMatchObject({
        protocolId: "p",
        fromBlock: "0x0",
        lastCoveredBlock: "0x28",
        sealedChunks: 2,
        gaps: [],
      });
      expect(out.hotHead).toMatchObject({ fromBlock: "0x20", toBlock: "0x28" });
      expect(out.totalCompressedSize).toMatch(/^0x[0-9a-f]+$/);
    });

    it("reports gaps in a non-contiguous chain", async () => {
      await publish(source, "p", [
        { from: 0n, to: 0x10n },
        { from: 0x20n, to: 0x30n }, // hole [0x10,0x20)
      ]);
      const out = JSON.parse(await cmdInfo(client, "p", { json: true }));
      expect(out.gaps).toEqual([{ from: "0x10", to: "0x20" }]);
      const human = await cmdInfo(client, "p", { json: false });
      expect(human).toContain("1 gap(s): [0x10,0x20)");
    });

    it("scopes the download size to a requested range", async () => {
      await publish(source, "p", [
        { from: 0n, to: 0x10n },
        { from: 0x10n, to: 0x20n },
      ]);
      const full = JSON.parse(await cmdInfo(client, "p", { json: true }));
      const scoped = JSON.parse(
        await cmdInfo(client, "p", { json: true, fromBlock: 0x10n }),
      );
      expect(BigInt(scoped.totalCompressedSize)).toBeLessThan(BigInt(full.totalCompressedSize));
    });

    it("throws on a protocol absent from a present manifest", async () => {
      await publish(source, "p", [{ from: 0n, to: 0x10n }]);
      await expect(cmdInfo(client, "nope", { json: true })).rejects.toThrow(/unknown protocol/);
    });
  });

  describe("head", () => {
    it("reports the last covered block (json)", async () => {
      await publish(source, "p", [{ from: 0n, to: 0x10n }], { from: 0x10n, to: 0x18n });
      const res = await cmdHead(client, "p", { json: true });
      expect(res.stale).toBe(false);
      expect(JSON.parse(res.text)).toMatchObject({ lastCoveredBlock: "0x18" });
    });

    it("--since is not stale when newer data exists", async () => {
      await publish(source, "p", [{ from: 0n, to: 0x20n }]);
      const res = await cmdHead(client, "p", { json: false, sinceBlock: 0x10n });
      expect(res.stale).toBe(false);
      expect(res.text).toContain("new data beyond 0x10");
    });

    it("--since is stale when nothing is newer", async () => {
      await publish(source, "p", [{ from: 0n, to: 0x20n }]);
      const res = await cmdHead(client, "p", { json: false, sinceBlock: 0x20n });
      expect(res.stale).toBe(true);
      expect(res.text).toContain("no new data since 0x20");
    });
  });

  describe("chunks", () => {
    it("lists sealed chunks in range (json), excluding the hot head by default", async () => {
      await publish(
        source,
        "p",
        [
          { from: 0n, to: 0x10n },
          { from: 0x10n, to: 0x20n },
        ],
        { from: 0x20n, to: 0x28n },
      );
      const all = JSON.parse(await cmdChunks(client, "p", { json: true, hot: false }));
      expect(all).toHaveLength(2);
      expect(all.map((c: { fromBlock: string }) => c.fromBlock)).toEqual(["0x0", "0x10"]);
    });

    it("--hot appends the hot head", async () => {
      await publish(source, "p", [{ from: 0n, to: 0x10n }], { from: 0x10n, to: 0x18n });
      const withHot = JSON.parse(await cmdChunks(client, "p", { json: true, hot: true }));
      expect(withHot).toHaveLength(2);
      expect(withHot[1].toBlock).toBe("0x18");
    });

    it("--from-block/--to-block filters the list", async () => {
      await publish(source, "p", [
        { from: 0n, to: 0x10n },
        { from: 0x10n, to: 0x20n },
        { from: 0x20n, to: 0x30n },
      ]);
      const mid = JSON.parse(
        await cmdChunks(client, "p", { json: true, hot: false, fromBlock: 0x10n, toBlock: 0x20n }),
      );
      expect(mid.map((c: { fromBlock: string }) => c.fromBlock)).toEqual(["0x10"]);
    });
  });
});
