import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DiskStore } from "@saga-sync/core/node";
import { Cursor } from "./cursor.js";

describe("Cursor", () => {
  let dir: string;
  let store: DiskStore;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cursor-test-"));
    store = new DiskStore(dir);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("loads empty when cursor.json is absent", async () => {
    const cursor = await Cursor.load(store);
    expect(cursor.lastScrapedBlock("proto-a")).toBeUndefined();
  });

  it("round-trips a set", async () => {
    const cursor = await Cursor.load(store);
    await cursor.set("proto-a", "0x10");
    const reloaded = await Cursor.load(store);
    expect(reloaded.lastScrapedBlock("proto-a")).toBe("0x10");
  });

  it("preserves other protocols when one is updated", async () => {
    const cursor = await Cursor.load(store);
    await cursor.set("proto-a", "0x10");
    await cursor.set("proto-b", "0x20");
    await cursor.set("proto-a", "0x30");
    const reloaded = await Cursor.load(store);
    expect(reloaded.lastScrapedBlock("proto-a")).toBe("0x30");
    expect(reloaded.lastScrapedBlock("proto-b")).toBe("0x20");
  });

  it("leaves no temp file behind", async () => {
    const cursor = await Cursor.load(store);
    await cursor.set("proto-a", "0x10");
    expect(readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  it("throws on a corrupt cursor file rather than silently resetting", async () => {
    writeFileSync(join(dir, "cursor.json"), "{ not valid json", "utf8");
    await expect(Cursor.load(store)).rejects.toThrow();
  });
});
