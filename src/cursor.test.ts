import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readCursor, writeCursor } from "./cursor.js";

describe("cursor", () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cursor-test-"));
    path = join(dir, "cursor.json");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("returns {} when the file does not exist", () => {
    expect(readCursor(path)).toEqual({});
  });

  it("round-trips a write", () => {
    writeCursor(path, "proto-a", "0x10");
    expect(readCursor(path)).toEqual({ "proto-a": { lastScrapedBlock: "0x10" } });
  });

  it("preserves other protocols when one is updated", () => {
    writeCursor(path, "proto-a", "0x10");
    writeCursor(path, "proto-b", "0x20");
    writeCursor(path, "proto-a", "0x30");
    expect(readCursor(path)).toEqual({
      "proto-a": { lastScrapedBlock: "0x30" },
      "proto-b": { lastScrapedBlock: "0x20" },
    });
  });

  it("leaves no temp file behind after writing", () => {
    writeCursor(path, "proto-a", "0x10");
    expect(existsSync(`${path}.${process.pid}.tmp`)).toBe(false);
  });

  it("throws on a corrupt cursor file rather than silently resetting", () => {
    writeFileSync(path, "{ not valid json", "utf8");
    expect(() => readCursor(path)).toThrow();
  });
});
