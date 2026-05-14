import { readFileSync, writeFileSync, renameSync } from "node:fs";
import type { Hex } from "viem";

// Keyed by the opaque protocol-instance id. `lastScrapedBlock` is the last block
// covered by a successful run; the next run resumes at lastScrapedBlock + 1.
export type Cursor = Record<string, { lastScrapedBlock: Hex }>;

export function readCursor(path: string): Cursor {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Cursor;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    // A corrupt cursor is a hard error — silently treating it as empty would
    // re-scrape from the cold-start block and flood the downstream consumer.
    throw new Error(`cursor ${path}: ${(err as Error).message}`);
  }
}

// Atomic update: write a sibling temp file, then rename over the target. The
// rename is atomic on a single filesystem, so a crash mid-write cannot leave a
// half-written cursor. Not safe for concurrent runs sharing one cursor file.
export function writeCursor(path: string, protocolId: string, lastScrapedBlock: Hex): void {
  const cursor = readCursor(path);
  cursor[protocolId] = { lastScrapedBlock };
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(cursor, null, 2) + "\n", "utf8");
  renameSync(tmp, path);
}
