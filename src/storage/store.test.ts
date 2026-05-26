import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DiskStore } from "./disk-store.js";
import { DryRunStore } from "./dry-run-store.js";
import { createStore } from "./index.js";

describe("DiskStore", () => {
  let dir: string;
  let store: DiskStore;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "disk-store-test-"));
    store = new DiskStore(dir);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("round-trips put and get", async () => {
    await store.put("a.txt", Buffer.from("hello"));
    const got = await store.get("a.txt");
    expect(got?.toString("utf8")).toBe("hello");
  });

  it("get resolves null for a missing key", async () => {
    expect(await store.get("nope.txt")).toBeNull();
  });

  it("delete is idempotent — no error when the key is absent", async () => {
    await expect(store.delete("nope.txt")).resolves.toBeUndefined();
    await store.put("x.txt", Buffer.from("y"));
    await store.delete("x.txt");
    expect(await store.get("x.txt")).toBeNull();
  });

  it("list returns keys filtered by prefix", async () => {
    await store.put("chunk-1.gz", Buffer.from("a"));
    await store.put("chunk-2.gz", Buffer.from("b"));
    await store.put("index.json", Buffer.from("c"));
    expect((await store.list("chunk-")).sort()).toEqual(["chunk-1.gz", "chunk-2.gz"]);
    expect(await store.list("index")).toEqual(["index.json"]);
  });

  it("list returns [] when the base dir does not exist", async () => {
    const ghost = new DiskStore(join(dir, "does-not-exist"));
    expect(await ghost.list("")).toEqual([]);
  });

  it("put leaves no temp file behind", async () => {
    await store.put("a.txt", Buffer.from("hello"));
    expect(readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  it("creates nested directories on put", async () => {
    const nested = new DiskStore(join(dir, "deep", "deeper"));
    await nested.put("f.txt", Buffer.from("ok"));
    expect((await nested.get("f.txt"))?.toString("utf8")).toBe("ok");
  });
});

describe("DryRunStore", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "dry-run-store-test-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("discards writes but passes reads through to the inner store", async () => {
    const inner = new DiskStore(dir);
    writeFileSync(join(dir, "seed.txt"), "from disk", "utf8");
    const dry = new DryRunStore(inner);

    await dry.put("new.txt", Buffer.from("should not persist"));
    expect(await dry.get("new.txt")).toBeNull(); // write was discarded
    expect((await dry.get("seed.txt"))?.toString("utf8")).toBe("from disk"); // read passes through
  });

  it("discards deletes", async () => {
    const inner = new DiskStore(dir);
    writeFileSync(join(dir, "keep.txt"), "x", "utf8");
    const dry = new DryRunStore(inner);
    await dry.delete("keep.txt");
    expect(await inner.get("keep.txt")).not.toBeNull(); // still there
  });
});

describe("createStore", () => {
  it("builds a DiskStore for protocol 'disk'", () => {
    expect(createStore({ protocol: "disk", baseDir: "." })).toBeInstanceOf(DiskStore);
  });

  it("wraps in a DryRunStore when dryRun is set", () => {
    expect(createStore({ protocol: "disk", baseDir: ".", dryRun: true })).toBeInstanceOf(
      DryRunStore,
    );
  });

  it("throws a clear error for not-yet-implemented protocols", () => {
    expect(() => createStore({ protocol: "s3" })).toThrow(/not implemented/);
    expect(() => createStore({ protocol: "http" })).toThrow(/not implemented/);
  });
});
