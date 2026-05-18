import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireLock, lastChunkToBlock } from "./cli.js";
import type { Manifest } from "../chunk-builder/manifest.js";
import type { ChunkMeta } from "../chunk-builder/seal.js";

const meta = (overrides: Partial<ChunkMeta> = {}): ChunkMeta => ({
  fromBlock: "0x10",
  toBlock: "0x20",
  file: "f",
  size: "0x1",
  digest: { type: "blake3", data: "0xaa" },
  ...overrides,
});

describe("lastChunkToBlock", () => {
  it("returns null when the protocol has no chunks", () => {
    const m: Manifest = { availableStates: {} };
    expect(lastChunkToBlock(m, "proto")).toBeNull();
  });

  it("returns null when the protocol key is absent", () => {
    const m: Manifest = { availableStates: { other: [meta()] } };
    expect(lastChunkToBlock(m, "proto")).toBeNull();
  });

  it("returns the last chunk's toBlock as a bigint", () => {
    const m: Manifest = {
      availableStates: {
        proto: [meta({ toBlock: "0x10" }), meta({ toBlock: "0x20" }), meta({ toBlock: "0x30" })],
      },
    };
    expect(lastChunkToBlock(m, "proto")).toBe(0x30n);
  });
});

describe("acquireLock", () => {
  let dir: string;
  let lockPath: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "orch-lock-test-"));
    lockPath = join(dir, ".orchestrator.lock");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("succeeds when the lockfile does not exist", () => {
    expect(acquireLock(lockPath)).toBe(true);
    expect(existsSync(lockPath)).toBe(true);
    expect(readFileSync(lockPath, "utf8")).toBe(String(process.pid));
  });

  it("returns false when a live process owns the lock", () => {
    // Write our own pid — we know it's alive (we ARE it).
    writeFileSync(lockPath, String(process.pid), "utf8");
    expect(acquireLock(lockPath)).toBe(false);
    // Lockfile is still intact
    expect(readFileSync(lockPath, "utf8")).toBe(String(process.pid));
  });

  it("reclaims a stale lock whose pid is not in the process table", () => {
    // A pid that's almost certainly not in use (max u16 + 1 on macOS is well past
    // typical pid ranges; -1 would actually be invalid to test against).
    writeFileSync(lockPath, "999999", "utf8");
    expect(acquireLock(lockPath)).toBe(true);
    expect(readFileSync(lockPath, "utf8")).toBe(String(process.pid));
  });

  it("reclaims a lockfile whose contents are garbage", () => {
    writeFileSync(lockPath, "not a pid", "utf8");
    expect(acquireLock(lockPath)).toBe(true);
  });
});
