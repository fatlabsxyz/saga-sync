import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import type { CanonicalEvent } from "../scraper/normalize.js";
import { DiskStore } from "@saga-sync/core/node";
import { ChunkArchive, buildJsonl } from "./archive.js";

const event = (overrides: Partial<CanonicalEvent> = {}): CanonicalEvent => ({
  contractAddress: "0x12d66f87a04a9e220743712ce6d9bb1b5616b8fc",
  eventTopic: "0xa945e51eec50ab98c161376f0db4cf2aeba3ec92755fe2fcd388bdbbb80ff196",
  topics: ["0xa945e51eec50ab98c161376f0db4cf2aeba3ec92755fe2fcd388bdbbb80ff196"],
  data: "0x",
  blockNumber: "0xc50101",
  logIndex: "0x0",
  ...overrides,
});

describe("buildJsonl", () => {
  it("returns an empty buffer for no events", () => {
    expect(buildJsonl([]).length).toBe(0);
  });

  it("joins events with newlines and a trailing newline", () => {
    const out = buildJsonl([event(), event({ logIndex: "0x1" })]).toString("utf8");
    expect(out.endsWith("\n")).toBe(true);
    expect(out.split("\n").filter((s) => s.length > 0)).toHaveLength(2);
  });
});

describe("ChunkArchive", () => {
  let dir: string;
  let archive: ChunkArchive;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "archive-test-"));
    archive = new ChunkArchive(new DiskStore(dir));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("seals an empty chunk with the canonical empty-input sha256 digest", async () => {
    const meta = await archive.seal("proto", [], { from: 0xc50101n, to: 0xc50200n });
    expect(meta.digest).toEqual({
      type: "sha256",
      data: "0xe3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    });
  });

  it("names sealed files with lowercase hex and a half-open range", async () => {
    const meta = await archive.seal("tornado-cash-1-eth-0.1", [], {
      from: 0xc50101n,
      to: 0xc50200n,
    });
    expect(meta.file).toBe("tornado-cash-1-eth-0.1-[0xc50101,0xc50200).jsonl.gz");
  });

  it("names hot-head files with a .hot.jsonl.gz suffix", async () => {
    const meta = await archive.writeHotHead("tornado-cash-1-eth-0.1", [event()], {
      from: 0xc50101n,
      to: 0xc50200n,
    });
    expect(meta.file).toBe("tornado-cash-1-eth-0.1-[0xc50101,0xc50200).hot.jsonl.gz");
  });

  it("sealed and hot files with the same events share a digest", async () => {
    const events = [event(), event({ logIndex: "0x1" })];
    const range = { from: 0xc50101n, to: 0xc50200n };
    const sealed = await archive.seal("p", events, range);
    const hot = await archive.writeHotHead("p", events, range);
    expect(hot.digest.data).toBe(sealed.digest.data);
  });

  it("readEvents round-trips what seal wrote", async () => {
    const events = [event(), event({ blockNumber: "0xc50102", logIndex: "0x1" })];
    const meta = await archive.seal("proto", events, { from: 0xc50101n, to: 0xc50200n });
    expect(await archive.readEvents(meta)).toEqual(events);
  });

  it("readEvents returns [] for an empty chunk", async () => {
    const meta = await archive.seal("proto", [], { from: 0xc50101n, to: 0xc50200n });
    expect(await archive.readEvents(meta)).toEqual([]);
  });

  it("reports size as the compressed byte length and gzip round-trips", async () => {
    const events = [event()];
    const meta = await archive.seal("proto", events, { from: 0xc50101n, to: 0xc50102n });
    const raw = await new DiskStore(dir).get(meta.file);
    expect(BigInt(meta.size)).toBe(BigInt(raw!.length));
    expect(gunzipSync(raw!).toString("utf8")).toBe(
      events.map((e) => JSON.stringify(e)).join("\n") + "\n",
    );
  });

  it("delete removes the chunk file", async () => {
    const meta = await archive.seal("proto", [event()], { from: 0xc50101n, to: 0xc50102n });
    const store = new DiskStore(dir);
    expect(await store.get(meta.file)).not.toBeNull();
    await archive.delete(meta);
    expect(await store.get(meta.file)).toBeNull();
  });
});
