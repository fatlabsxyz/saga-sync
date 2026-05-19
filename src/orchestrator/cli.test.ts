import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireLock, lastCoveredBlock } from "./cli.js";
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

describe("lastCoveredBlock", () => {
  it("returns null when the protocol has no chunks or hot head", () => {
    const m: Manifest = { availableStates: {} };
    expect(lastCoveredBlock(m, "proto")).toBeNull();
  });

  it("returns null when the protocol key is absent in both maps", () => {
    const m: Manifest = { availableStates: { other: [meta()] }, hotHeads: { other: meta() } };
    expect(lastCoveredBlock(m, "proto")).toBeNull();
  });

  it("returns the last sealed chunk's toBlock when there is no hot head", () => {
    const m: Manifest = {
      availableStates: {
        proto: [meta({ toBlock: "0x10" }), meta({ toBlock: "0x20" }), meta({ toBlock: "0x30" })],
      },
    };
    expect(lastCoveredBlock(m, "proto")).toBe(0x30n);
  });

  it("returns the hot head's toBlock when it's further than any sealed chunk", () => {
    const m: Manifest = {
      availableStates: { proto: [meta({ toBlock: "0x20" })] },
      hotHeads: { proto: meta({ toBlock: "0x50" }) },
    };
    expect(lastCoveredBlock(m, "proto")).toBe(0x50n);
  });

  it("returns the sealed toBlock when the hot head is stale (behind sealed)", () => {
    const m: Manifest = {
      availableStates: { proto: [meta({ toBlock: "0x50" })] },
      hotHeads: { proto: meta({ toBlock: "0x30" }) },
    };
    expect(lastCoveredBlock(m, "proto")).toBe(0x50n);
  });

  it("returns the hot head's toBlock when there are no sealed chunks", () => {
    const m: Manifest = {
      availableStates: {},
      hotHeads: { proto: meta({ toBlock: "0x100" }) },
    };
    expect(lastCoveredBlock(m, "proto")).toBe(0x100n);
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
