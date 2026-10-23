import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Manifest } from "@saga-sync/core";
import { DiskStore } from "@saga-sync/core/node";
import { acquireLock, runPool, extraLogFieldsMismatch } from "./cli.js";
import type { ScraperTarget } from "../scraper/config.js";

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

describe("runPool", () => {
  it("runs the worker over every item exactly once", async () => {
    const seen: number[] = [];
    await runPool([1, 2, 3, 4, 5], 2, async (n) => {
      seen.push(n);
    });
    expect(seen.sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
  });

  it("never exceeds the concurrency cap yet still parallelizes", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const done: number[] = [];
    await runPool(
      Array.from({ length: 10 }, (_, i) => i),
      3,
      async (n) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight -= 1;
        done.push(n);
      },
    );
    expect(maxInFlight).toBeLessThanOrEqual(3);
    expect(maxInFlight).toBeGreaterThan(1); // actually ran in parallel
    expect(done).toHaveLength(10);
  });

  it("keeps draining fast items while a slow one is in flight", async () => {
    const order: string[] = [];
    await runPool(["slow", "a", "b", "c"], 2, async (x) => {
      if (x === "slow") await new Promise((r) => setTimeout(r, 30));
      order.push(x);
    });
    // The slow item was picked first but finishes last; the fast ones drain past it.
    expect(order).toHaveLength(4);
    expect(order[order.length - 1]).toBe("slow");
  });

  it("caps workers at the item count when concurrency exceeds it", async () => {
    const seen: number[] = [];
    await runPool([1, 2], 10, async (n) => {
      seen.push(n);
    });
    expect(seen.sort((a, b) => a - b)).toEqual([1, 2]);
  });
});

describe("extraLogFieldsMismatch", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "orch-extra-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const target = (extraLogFields?: ScraperTarget["extraLogFields"]): ScraperTarget => ({
    chainId: "0x1",
    fromBlock: "0x1",
    source: { kind: "rpc" },
    ...(extraLogFields ? { extraLogFields } : {}),
  });
  const chunk = {
    fromBlock: "0x1" as const,
    toBlock: "0x5" as const,
    file: "p.gz",
    size: "0x0" as const,
    digest: { type: "sha256" as const, data: "0x0" as const },
  };

  it("allows any declaration on a stream with nothing published", async () => {
    const m = await Manifest.load(new DiskStore(dir));
    expect(extraLogFieldsMismatch(m, "p", target(["transactionHash"]))).toBeNull();
  });

  it("allows extending a stream published with the same set", async () => {
    const m = await Manifest.load(new DiskStore(dir));
    await m.setProtocolMeta("p", { extraLogFields: ["transactionHash"] });
    await m.appendChunk("p", chunk);
    expect(extraLogFieldsMismatch(m, "p", target(["transactionHash"]))).toBeNull();
  });

  it("refuses to add a field to an already-published stream", async () => {
    const m = await Manifest.load(new DiskStore(dir));
    await m.appendChunk("p", chunk);
    expect(extraLogFieldsMismatch(m, "p", target(["transactionHash"]))).toMatch(
      /published with \[none\]/,
    );
  });

  it("refuses to drop a field from an already-published stream", async () => {
    const m = await Manifest.load(new DiskStore(dir));
    await m.setProtocolMeta("p", { extraLogFields: ["transactionHash"] });
    await m.appendChunk("p", chunk);
    expect(extraLogFieldsMismatch(m, "p", target())).toMatch(/asks for extraLogFields \[none\]/);
  });
});
