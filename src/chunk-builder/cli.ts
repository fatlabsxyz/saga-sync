#!/usr/bin/env node
import { parseArgs } from "node:util";
import { mkdirSync, realpathSync } from "node:fs";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { numberToHex } from "viem";
import type { CanonicalEvent } from "../scraper/normalize.js";
import { sealChunk } from "./seal.js";
import type { ChunkMeta } from "./seal.js";
import { appendToManifest } from "./manifest.js";

const DEFAULT_SIZE_LIMIT = 10 * 1024 * 1024; // 10 MiB

const USAGE = `chunk-builder — partition scraper NDJSON into immutable .jsonl.gz chunks

Usage:
  chunk-builder --protocol-id <id> --from-block <hex> --to-block <hex> --output-dir <path> [options]

Required:
  --protocol-id <id>     manifest key + filename prefix
  --from-block <hex>     inclusive start of the scanned range
  --to-block <hex>       exclusive end of the scanned range
  --output-dir <path>    where to write chunks + index.json (created if missing)

Options:
  --size-limit <n>       max uncompressed bytes per chunk, default ${DEFAULT_SIZE_LIMIT} (10 MiB)
  --dry-run              compute chunk metadata but do not write files or manifest
  --help                 show this message
`;

function fail(msg: string): never {
  process.stderr.write(`chunk-builder: ${msg}\n`);
  process.exit(1);
}

function parseCliArgs() {
  const { values } = parseArgs({
    options: {
      "protocol-id": { type: "string" },
      "from-block": { type: "string" },
      "to-block": { type: "string" },
      "output-dir": { type: "string" },
      "size-limit": { type: "string" },
      "dry-run": { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  });

  if (values.help) {
    process.stdout.write(USAGE);
    process.exit(0);
  }

  const need = (name: "protocol-id" | "from-block" | "to-block" | "output-dir"): string => {
    const v = values[name];
    if (!v) fail(`missing required --${name}\n\n${USAGE}`);
    return v;
  };

  const fromBlock = BigInt(need("from-block"));
  const toBlock = BigInt(need("to-block"));
  if (fromBlock >= toBlock) {
    fail(`--from-block (${numberToHex(fromBlock)}) must be < --to-block (${numberToHex(toBlock)})`);
  }

  const sizeLimit = values["size-limit"] ? Number(values["size-limit"]) : DEFAULT_SIZE_LIMIT;
  if (!Number.isFinite(sizeLimit) || sizeLimit <= 0) {
    fail(`--size-limit must be a positive integer; got ${values["size-limit"]}`);
  }

  return {
    protocolId: need("protocol-id"),
    fromBlock,
    toBlock,
    outputDir: resolve(need("output-dir")),
    sizeLimit,
    dryRun: values["dry-run"] ?? false,
  };
}

export type ProcessArgs = {
  protocolId: string;
  fromBlock: bigint;
  toBlock: bigint;
  outputDir: string;
  sizeLimit: number;
  dryRun: boolean;
  // Optional: events from a previous hot head, loaded into the accumulator
  // before the new stream begins. `chunkFrom` is the start of the resulting
  // chunk's range — typically the old hot head's fromBlock, which is earlier
  // than args.fromBlock. Seeded events bypass the range check (they were
  // validated by the previous batch).
  seed?: { events: CanonicalEvent[]; chunkFrom: bigint };
  // "seal" (default): trailing accumulator is sealed at EOF, same as before.
  // "suspend": trailing accumulator is returned in `trailing`; caller decides
  //   whether to persist it as a hot head or to seal it.
  trailingMode?: "seal" | "suspend";
};

export type ProcessResult = {
  sealed: ChunkMeta[];
  // Present only when trailingMode === "suspend". `events` may be empty if all
  // scraped data fit into the sealed chunks; the range is still reported so the
  // caller can persist an empty hot head asserting "scanned up to here."
  trailing?: { events: CanonicalEvent[]; fromBlock: bigint; toBlock: bigint };
};

// Block-aligned chunk partitioning. Maintains a `pending` buffer for the
// in-progress block; only commits a block's events to the current chunk when
// the next block arrives. That guarantees chunk boundaries always fall between
// blocks, never within one (so a multi-event block can't be split across chunks).
// On EOF, the trailing accumulator is either sealed (seal mode) or returned
// to the caller (suspend mode) — that's what enables hot-head carry-over.
export async function processStream(
  lines: AsyncIterable<string>,
  args: ProcessArgs,
): Promise<ProcessResult> {
  const manifestPath = join(args.outputDir, "index.json");
  const sealed: ChunkMeta[] = [];

  let accumulated: CanonicalEvent[] = [];
  let accumulatedBytes = 0;
  let chunkFrom = args.seed?.chunkFrom ?? args.fromBlock;

  let pending: CanonicalEvent[] = [];
  let pendingBytes = 0;
  let pendingBlock: bigint | null = null;

  const flushSeal = (to: bigint): void => {
    const meta = sealChunk(
      accumulated,
      { from: chunkFrom, to },
      { outputDir: args.outputDir, protocolId: args.protocolId, dryRun: args.dryRun },
    );
    if (!args.dryRun) appendToManifest(manifestPath, args.protocolId, meta);
    sealed.push(meta);
    chunkFrom = to;
    accumulated = [];
    accumulatedBytes = 0;
  };

  // Inner state-machine step. `isSeed` skips the range check for events that
  // came from the prior hot head — those are by definition earlier than the
  // new scan's fromBlock and shouldn't be rejected.
  const ingest = (event: CanonicalEvent, lineBytes: number, isSeed: boolean): void => {
    if (typeof event.blockNumber !== "string") {
      throw new Error(`event missing blockNumber: ${JSON.stringify(event).slice(0, 120)}`);
    }
    const eventBlock = BigInt(event.blockNumber);
    if (!isSeed && (eventBlock < args.fromBlock || eventBlock >= args.toBlock)) {
      throw new Error(
        `event at block ${event.blockNumber} outside scanned range ` +
          `[${numberToHex(args.fromBlock)}, ${numberToHex(args.toBlock)})`,
      );
    }

    if (pendingBlock !== null && eventBlock !== pendingBlock) {
      if (accumulatedBytes + pendingBytes > args.sizeLimit && accumulated.length > 0) {
        flushSeal(pendingBlock);
      }
      accumulated.push(...pending);
      accumulatedBytes += pendingBytes;
      pending = [];
      pendingBytes = 0;
    }

    pendingBlock = eventBlock;
    pending.push(event);
    pendingBytes += lineBytes;
  };

  // Seed events come first — they're treated as if they were the leading
  // lines of the stream. Their byte size matches what JSON.stringify(event)
  // would produce, since that's what the hot head's JSONL was built from.
  if (args.seed) {
    for (const e of args.seed.events) {
      const lineBytes = Buffer.byteLength(JSON.stringify(e) + "\n", "utf8");
      ingest(e, lineBytes, true);
    }
  }

  for await (const rawLine of lines) {
    const line = rawLine.trim();
    if (line === "") continue;

    let event: CanonicalEvent;
    try {
      event = JSON.parse(line) as CanonicalEvent;
    } catch (err) {
      throw new Error(`malformed NDJSON line: ${(err as Error).message}`);
    }
    const lineBytes = Buffer.byteLength(JSON.stringify(event) + "\n", "utf8");
    ingest(event, lineBytes, false);
  }

  // Flush any remaining pending into accumulated. There's no further block to
  // bound it against, so we treat it the same as the previous block transition.
  if (pending.length > 0 && pendingBlock !== null) {
    if (accumulatedBytes + pendingBytes > args.sizeLimit && accumulated.length > 0) {
      flushSeal(pendingBlock);
    }
    accumulated.push(...pending);
    accumulatedBytes += pendingBytes;
  }

  const mode = args.trailingMode ?? "seal";
  if (mode === "seal") {
    // Always emit a final chunk covering up to args.toBlock — even with zero
    // events. This is what makes the manifest assert full range coverage.
    flushSeal(args.toBlock);
    return { sealed };
  }

  // Suspend mode: caller wants the trailing accumulator back rather than sealed.
  // The trailing range is [chunkFrom, args.toBlock) — same range the seal call
  // would have used, just expressed in the result instead.
  return {
    sealed,
    trailing: {
      events: accumulated,
      fromBlock: chunkFrom,
      toBlock: args.toBlock,
    },
  };
}

async function main(): Promise<void> {
  const args = parseCliArgs();
  if (!args.dryRun) mkdirSync(args.outputDir, { recursive: true });

  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const { sealed } = await processStream(rl, args);

  process.stderr.write(
    `chunk-builder: ${sealed.length} chunk(s) for ${args.protocolId} ` +
      `[${numberToHex(args.fromBlock)}, ${numberToHex(args.toBlock)})` +
      (args.dryRun ? " (dry-run: no files or manifest written)\n" : "\n"),
  );
}

function isMainModule(): boolean {
  try {
    return realpathSync(process.argv[1] ?? "") === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMainModule()) {
  main().catch((err: unknown) => {
    fail(err instanceof Error ? err.message : String(err));
  });
}
