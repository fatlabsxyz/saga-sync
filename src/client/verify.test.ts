import { describe, it, expect } from "vitest";
import { blake3 } from "@noble/hashes/blake3.js";
import type { Hex } from "viem";
import type { ChunkMeta } from "../chunk-builder/manifest.js";
import { verifyDigest, DigestMismatchError } from "./verify.js";

function metaFor(bytes: Buffer, digestOverride?: string): ChunkMeta {
  const data = (digestOverride ??
    `0x${Buffer.from(blake3(bytes)).toString("hex")}`) as Hex;
  return {
    fromBlock: "0x1",
    toBlock: "0x2",
    file: "p-[0x1,0x2).jsonl.gz",
    size: "0x0",
    digest: { type: "blake3", data },
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
    const hex = Buffer.from(blake3(bytes)).toString("hex").toUpperCase();
    expect(() => verifyDigest(metaFor(bytes, hex), bytes)).not.toThrow();
  });

  it("rejects an unsupported digest type", () => {
    const meta = metaFor(bytes);
    (meta.digest as { type: string }).type = "sha256";
    expect(() => verifyDigest(meta, bytes)).toThrow(/unsupported digest type/);
  });
});
