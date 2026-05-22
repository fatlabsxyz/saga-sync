import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireLock } from "./cli.js";

// lastCoveredBlock moved onto the Manifest class — its cases now live in
// src/chunk-builder/manifest.test.ts.

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
