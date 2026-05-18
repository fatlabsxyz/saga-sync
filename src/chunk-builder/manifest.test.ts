import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readManifest, appendToManifest } from "./manifest.js";
import type { ChunkMeta } from "./seal.js";

const meta = (overrides: Partial<ChunkMeta> = {}): ChunkMeta => ({
  fromBlock: "0xc50101",
  toBlock: "0xc50200",
  file: "proto-[0xc50101,0xc50200).jsonl.gz",
  size: "0x1a2",
  digest: { type: "blake3", data: "0xabcd" },
  ...overrides,
});

describe("manifest", () => {
  let dir: string;
  let path: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "manifest-test-"));
    path = join(dir, "index.json");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("readManifest returns an empty structure when the file is absent", () => {
    expect(readManifest(path)).toEqual({ availableStates: {} });
  });

  it("first append creates the protocol entry", () => {
    appendToManifest(path, "proto-a", meta());
    expect(readManifest(path).availableStates["proto-a"]).toEqual([meta()]);
  });

  it("subsequent appends extend the array in order", () => {
    appendToManifest(path, "proto-a", meta({ fromBlock: "0x1" }));
    appendToManifest(path, "proto-a", meta({ fromBlock: "0x2" }));
    appendToManifest(path, "proto-a", meta({ fromBlock: "0x3" }));
    const list = readManifest(path).availableStates["proto-a"];
    expect(list?.map((m) => m.fromBlock)).toEqual(["0x1", "0x2", "0x3"]);
  });

  it("keeps separate arrays per protocolId", () => {
    appendToManifest(path, "proto-a", meta({ fromBlock: "0xa" }));
    appendToManifest(path, "proto-b", meta({ fromBlock: "0xb" }));
    const out = readManifest(path).availableStates;
    expect(out["proto-a"]?.[0]?.fromBlock).toBe("0xa");
    expect(out["proto-b"]?.[0]?.fromBlock).toBe("0xb");
  });

  it("leaves no temp file behind", () => {
    appendToManifest(path, "proto-a", meta());
    expect(existsSync(`${path}.${process.pid}.tmp`)).toBe(false);
  });

  it("throws on a corrupt manifest rather than silently resetting", () => {
    writeFileSync(path, "{ not valid json", "utf8");
    expect(() => readManifest(path)).toThrow();
  });

  it("recovers to an empty structure when the file is missing availableStates", () => {
    writeFileSync(path, JSON.stringify({ other: 1 }), "utf8");
    expect(readManifest(path)).toEqual({ availableStates: {} });
  });
});
