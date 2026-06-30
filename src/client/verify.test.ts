import { describe, it, expect } from "vitest";
import type { Hex } from "viem";
import type { ChunkMeta } from "../chunk-builder/manifest.js";
import { sha256Hex } from "../hash.js";
import type { CanonicalEvent } from "../scraper/normalize.js";
import {
  verifyDigest,
  DigestMismatchError,
  verifyChunkEvents,
  CanonicalFormError,
} from "./verify.js";

function metaFor(bytes: Buffer, digestOverride?: string): ChunkMeta {
  const data = (digestOverride ?? sha256Hex(bytes)) as Hex;
  return {
    fromBlock: "0x1",
    toBlock: "0x2",
    file: "p-[0x1,0x2).jsonl.gz",
    size: "0x0",
    digest: { type: "sha256", data },
  };
}

describe("verifyDigest", () => {
  const bytes = Buffer.from('{"blockNumber":"0x1"}\n', "utf8");

  it("passes when the digest matches", () => {
    expect(() => verifyDigest(metaFor(bytes), bytes)).not.toThrow();
  });

  it("throws DigestMismatchError when the bytes differ", () => {
    const meta = metaFor(bytes);
    expect(() => verifyDigest(meta, Buffer.from("tampered"))).toThrow(DigestMismatchError);
  });

  it("error carries expected and actual hexes", () => {
    const meta = metaFor(bytes);
    try {
      verifyDigest(meta, Buffer.from("tampered"));
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(DigestMismatchError);
      const e = err as DigestMismatchError;
      expect(e.expected).toBe(meta.digest.data.toLowerCase());
      expect(e.actual).toMatch(/^0x[0-9a-f]+$/);
      expect(e.actual).not.toBe(e.expected);
    }
  });

  it("tolerates an un-prefixed, upper-case manifest digest", () => {
    const hex = sha256Hex(bytes).slice(2).toUpperCase();
    expect(() => verifyDigest(metaFor(bytes, hex), bytes)).not.toThrow();
  });

  it("rejects an unsupported digest type", () => {
    const meta = metaFor(bytes);
    (meta.digest as { type: string }).type = "blake3";
    expect(() => verifyDigest(meta, bytes)).toThrow(/unsupported digest type/);
  });
});

describe("verifyChunkEvents", () => {
  const ev = (block: number, logIndex = 0): CanonicalEvent => ({
    contractAddress: "0xabc",
    eventTopic: "0xdef",
    topics: ["0xdef"],
    data: "0x",
    blockNumber: `0x${block.toString(16)}`,
    logIndex: `0x${logIndex.toString(16)}`,
  });
  const rangeMeta = (from: number, to: number): ChunkMeta => ({
    fromBlock: `0x${from.toString(16)}`,
    toBlock: `0x${to.toString(16)}`,
    file: "p-[range).jsonl.gz",
    size: "0x0",
    digest: { type: "sha256", data: "0x0" },
  });

  it("passes for in-range, strictly ascending events", () => {
    const meta = rangeMeta(0x10, 0x20);
    expect(() =>
      verifyChunkEvents(meta, [ev(0x10), ev(0x10, 1), ev(0x12), ev(0x1f, 5)]),
    ).not.toThrow();
  });

  it("passes for an empty chunk", () => {
    expect(() => verifyChunkEvents(rangeMeta(0x10, 0x20), [])).not.toThrow();
  });

  it("throws when an event is below fromBlock", () => {
    expect(() => verifyChunkEvents(rangeMeta(0x10, 0x20), [ev(0xf)])).toThrow(CanonicalFormError);
  });

  it("throws when an event is at/above toBlock (exclusive end)", () => {
    expect(() => verifyChunkEvents(rangeMeta(0x10, 0x20), [ev(0x20)])).toThrow(/outside/);
  });

  it("throws when blocks are not ascending", () => {
    expect(() => verifyChunkEvents(rangeMeta(0x10, 0x20), [ev(0x12), ev(0x11)])).toThrow(
      /strictly ascending/,
    );
  });

  it("throws on a duplicate (blockNumber, logIndex)", () => {
    expect(() =>
      verifyChunkEvents(rangeMeta(0x10, 0x20), [ev(0x12, 3), ev(0x12, 3)]),
    ).toThrow(CanonicalFormError);
  });
});
