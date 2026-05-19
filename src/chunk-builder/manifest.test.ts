import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readManifest, appendToManifest, setHotHead, clearHotHead } from "./manifest.js";
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

  it("setHotHead creates the hotHeads field and stores one entry per protocol", () => {
    setHotHead(path, "proto-a", meta({ toBlock: "0x100" }));
    setHotHead(path, "proto-b", meta({ toBlock: "0x200" }));
    const m = readManifest(path);
    expect(m.hotHeads).toBeDefined();
    expect(m.hotHeads!["proto-a"]?.toBlock).toBe("0x100");
    expect(m.hotHeads!["proto-b"]?.toBlock).toBe("0x200");
  });

  it("setHotHead replaces an existing entry (one per protocol)", () => {
    setHotHead(path, "proto-a", meta({ toBlock: "0x100" }));
    setHotHead(path, "proto-a", meta({ toBlock: "0x200" }));
    expect(readManifest(path).hotHeads!["proto-a"]?.toBlock).toBe("0x200");
  });

  it("setHotHead does not touch availableStates", () => {
    appendToManifest(path, "proto-a", meta({ toBlock: "0xfff" }));
    setHotHead(path, "proto-a", meta({ toBlock: "0x100" }));
    const m = readManifest(path);
    expect(m.availableStates["proto-a"]).toHaveLength(1);
    expect(m.availableStates["proto-a"]?.[0]?.toBlock).toBe("0xfff");
  });

  it("clearHotHead removes the entry and is a no-op when nothing is set", () => {
    clearHotHead(path, "proto-a"); // no-op, no file exists
    setHotHead(path, "proto-a", meta());
    setHotHead(path, "proto-b", meta());
    clearHotHead(path, "proto-a");
    const m = readManifest(path);
    expect(m.hotHeads).toBeDefined();
    expect("proto-a" in m.hotHeads!).toBe(false);
    expect(m.hotHeads!["proto-b"]).toBeDefined();
  });

  it("clearHotHead removes the hotHeads field entirely when it's the last entry", () => {
    setHotHead(path, "proto-a", meta());
    clearHotHead(path, "proto-a");
    const m = readManifest(path);
    expect(m.hotHeads).toBeUndefined();
  });
});
