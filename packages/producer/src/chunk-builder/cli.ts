#!/usr/bin/env node
import { parseArgs } from "node:util";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { numberToHex } from "viem";
import type { CanonicalEvent } from "../scraper/normalize.js";
import { createStore, parseStoreTarget } from "../storage/index.js";
import { ChunkArchive } from "./archive.js";
import { ChunkAccumulator } from "./accumulator.js";
import type { CompletedChunk } from "./accumulator.js";
import { Manifest } from "@saga-sync/core";
import { signerFromEnv } from "@saga-sync/core";
import type { ChunkMeta } from "@saga-sync/core";

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
    output: need("output-dir"), // raw — may be a local dir or a gs:// target
    sizeLimit,
    dryRun: values["dry-run"] ?? false,
  };
}

export type ProcessArgs = {
  protocolId: string;
  fromBlock: bigint;
  toBlock: bigint;
  sizeLimit: number;
  archive: ChunkArchive;
  manifest: Manifest;
  // Optional: events from a previous hot head, loaded into the accumulator
  // before the new stream begins. `chunkFrom` is the start of the resulting
  // chunk's range. Seeded events bypass the range check (they were validated
  // by the previous batch).
  seed?: { events: CanonicalEvent[]; chunkFrom: bigint };
  // "seal" (default): trailing accumulator is sealed at EOF. "suspend": it is
  // returned in `trailing` for the caller to persist as a hot head.
  trailingMode?: "seal" | "suspend";
};

export type ProcessResult = {
  sealed: ChunkMeta[];
  // Present only when trailingMode === "suspend". `events` may be empty.
  trailing?: { events: CanonicalEvent[]; fromBlock: bigint; toBlock: bigint };
};

// Reads CanonicalEvent NDJSON, partitions it into chunks via ChunkAccumulator,
// and seals each completed chunk through ChunkArchive + Manifest. The trailing
// accumulator is either sealed (seal mode) or returned (suspend mode — the
// hot-head carry-over path).
export async function processStream(
  lines: AsyncIterable<string>,
  args: ProcessArgs,
): Promise<ProcessResult> {
  const sealed: ChunkMeta[] = [];
  const chunkFrom = args.seed?.chunkFrom ?? args.fromBlock;
  const accumulator = new ChunkAccumulator(args.sizeLimit, chunkFrom);

  const sealCompleted = async (c: CompletedChunk): Promise<void> => {
    const meta = await args.archive.seal(args.protocolId, c.events, { from: c.from, to: c.to });
    await args.manifest.appendChunk(args.protocolId, meta);
    sealed.push(meta);
  };

  // Seed events (from a prior hot head) lead the stream and skip the range check.
  if (args.seed) {
    for (const event of args.seed.events) {
      const completed = accumulator.add(event);
      if (completed) await sealCompleted(completed);
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
    if (typeof event.blockNumber !== "string") {
      throw new Error(`event missing blockNumber: ${line.slice(0, 120)}`);
    }
    const eventBlock = BigInt(event.blockNumber);
    if (eventBlock < args.fromBlock || eventBlock >= args.toBlock) {
      throw new Error(
        `event at block ${event.blockNumber} outside scanned range ` +
          `[${numberToHex(args.fromBlock)}, ${numberToHex(args.toBlock)})`,
      );
    }

    const completed = accumulator.add(event);
    if (completed) await sealCompleted(completed);
  }

  const { completed, trailing } = accumulator.finish();
  if (completed) await sealCompleted(completed);

  if ((args.trailingMode ?? "seal") === "seal") {
    // Seal the trailing accumulator as a final chunk up to args.toBlock — even
    // with zero events, so the manifest asserts full range coverage.
    const meta = await args.archive.seal(args.protocolId, trailing.events, {
      from: trailing.fromBlock,
      to: args.toBlock,
    });
    await args.manifest.appendChunk(args.protocolId, meta);
    sealed.push(meta);
    return { sealed };
  }

  return {
    sealed,
    trailing: { events: trailing.events, fromBlock: trailing.fromBlock, toBlock: args.toBlock },
  };
}

async function main(): Promise<void> {
  const args = parseCliArgs();
  const store = createStore({ ...parseStoreTarget(args.output), dryRun: args.dryRun });
  const archive = new ChunkArchive(store);
  const manifest = await Manifest.load(store, undefined, { signer: signerFromEnv() });

  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const { sealed } = await processStream(rl, {
    protocolId: args.protocolId,
    fromBlock: args.fromBlock,
    toBlock: args.toBlock,
    sizeLimit: args.sizeLimit,
    archive,
    manifest,
  });

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
