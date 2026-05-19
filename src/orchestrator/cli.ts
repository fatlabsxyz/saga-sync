#!/usr/bin/env node
import { parseArgs } from "node:util";
import {
  mkdirSync,
  openSync,
  writeFileSync,
  closeSync,
  unlinkSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, http, numberToHex } from "viem";
import type { PublicClient } from "viem";
import { finalizedBlock, assertChainId } from "../scraper/cli.js";
import { loadAllProtocols } from "../scraper/config.js";
import type { ScraperTarget } from "../scraper/config.js";
import { readManifest, setHotHead, clearHotHead } from "../chunk-builder/manifest.js";
import type { Manifest } from "../chunk-builder/manifest.js";
import { sealChunk, readChunkFile } from "../chunk-builder/seal.js";
import type { ChunkMeta } from "../chunk-builder/seal.js";
import type { CanonicalEvent } from "../scraper/normalize.js";
import { runProtocolOnce } from "./pipeline.js";

const DEFAULT_WINDOW = 2000;
const DEFAULT_CONFIRMATIONS = 12n;
const DEFAULT_SIZE_LIMIT = 10 * 1024 * 1024;
const DEFAULT_BATCH_SIZE = 100_000n;

const USAGE = `orchestrator — run scrape→chunk in batches for every protocol

Usage:
  orchestrator --config <path> --rpc <url> --output-dir <path> [options]

Required:
  --config <path>        scraper config JSON (all protocols read)
  --rpc <url>            Ethereum JSON-RPC URL (single chain per run)
  --output-dir <path>    chunks + index.json directory

Options:
  --lock-dir <path>      directory for .orchestrator.lock; default = output-dir
  --protocol-id <id>     restrict to one protocol (backfills / ad-hoc runs)
  --batch-size <n>       blocks per batch (default 100000). Smaller batches
                         bound the crash blast radius; larger batches reduce
                         hot-head rewrite overhead.
  --confirmations <n>    fallback reorg buffer when "finalized" tag is unsupported
                         (default 12)
  --window <n>           scraper window size in blocks (default 2000)
  --size-limit <n>       chunk size cap in bytes if config does not specify it
                         (default 10485760 = 10 MiB)
  --dry-run              compute what would run, don't touch disk
  --help
`;

function fail(msg: string): never {
  process.stderr.write(`orchestrator: ${msg}\n`);
  process.exit(1);
}

function parseCliArgs() {
  const { values } = parseArgs({
    options: {
      config: { type: "string" },
      rpc: { type: "string" },
      "output-dir": { type: "string" },
      "lock-dir": { type: "string" },
      "protocol-id": { type: "string" },
      "batch-size": { type: "string" },
      confirmations: { type: "string" },
      window: { type: "string" },
      "size-limit": { type: "string" },
      "dry-run": { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  });

  if (values.help) {
    process.stdout.write(USAGE);
    process.exit(0);
  }

  const need = (name: "config" | "rpc" | "output-dir"): string => {
    const v = values[name];
    if (!v) fail(`missing required --${name}\n\n${USAGE}`);
    return v;
  };

  const batchSize = values["batch-size"] ? BigInt(values["batch-size"]) : DEFAULT_BATCH_SIZE;
  if (batchSize <= 0n) fail(`--batch-size must be positive; got ${values["batch-size"]}`);

  return {
    configPath: resolve(need("config")),
    rpc: need("rpc"),
    outputDir: resolve(need("output-dir")),
    lockDir: values["lock-dir"] ? resolve(values["lock-dir"]) : undefined,
    protocolId: values["protocol-id"],
    batchSize,
    confirmations: values.confirmations ? BigInt(values.confirmations) : DEFAULT_CONFIRMATIONS,
    window: values.window ? Number(values.window) : DEFAULT_WINDOW,
    sizeLimit: values["size-limit"] ? Number(values["size-limit"]) : DEFAULT_SIZE_LIMIT,
    dryRun: values["dry-run"] ?? false,
  };
}

// Atomic lock acquisition with stale-pid recovery. Returns true if we got the
// lock, false if another live process already holds it. Throws on hard errors.
export function acquireLock(path: string): boolean {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const fd = openSync(path, "wx");
      writeFileSync(fd, String(process.pid), "utf8");
      closeSync(fd);
      const cleanup = (): void => {
        try {
          unlinkSync(path);
        } catch {
          /* already gone */
        }
      };
      process.on("exit", cleanup);
      process.on("SIGINT", () => {
        cleanup();
        process.exit(130);
      });
      process.on("SIGTERM", () => {
        cleanup();
        process.exit(143);
      });
      return true;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw err;

      // Lock exists; check whether the recorded pid is still alive.
      let stalePid: number;
      try {
        stalePid = parseInt(readFileSync(path, "utf8").trim(), 10);
      } catch {
        // Couldn't read the lockfile (race?) — try again
        continue;
      }
      if (!Number.isFinite(stalePid) || stalePid <= 0) {
        try {
          unlinkSync(path);
        } catch {
          /* race with another recovery */
        }
        continue;
      }
      try {
        process.kill(stalePid, 0);
        // Owner is alive
        return false;
      } catch (e) {
        const ec = (e as NodeJS.ErrnoException).code;
        if (ec === "ESRCH") {
          try {
            unlinkSync(path);
          } catch {
            /* race */
          }
          continue;
        }
        // EPERM: process exists but we can't signal it — treat as alive
        return false;
      }
    }
  }
  return false;
}

// Highest block any artifact (sealed chunk or hot head) covers for a protocol.
// Robust to the post-crash overlap case where a sealed chunk consumed the hot
// head's range but the hot-head entry wasn't yet cleared from the manifest.
export function lastCoveredBlock(manifest: Manifest, protocolId: string): bigint | null {
  const chunks = manifest.availableStates[protocolId];
  const last = chunks && chunks.length > 0 ? chunks[chunks.length - 1] : undefined;
  const sealedTo = last ? BigInt(last.toBlock) : null;
  const hot = manifest.hotHeads?.[protocolId];
  const hotTo = hot ? BigInt(hot.toBlock) : null;
  if (sealedTo === null && hotTo === null) return null;
  if (sealedTo === null) return hotTo;
  if (hotTo === null) return sealedTo;
  return sealedTo > hotTo ? sealedTo : hotTo;
}

// Process one protocol: load + clean any prior hot head, loop in batches,
// persist the final trailing accumulator as the new hot head. Returns the
// total number of immutable chunks sealed across all batches.
async function processProtocol(args: {
  client: PublicClient;
  protocolId: string;
  protocol: ScraperTarget;
  outputDir: string;
  manifestPath: string;
  manifest: Manifest;
  tip: bigint;
  batchSize: bigint;
  window: number;
  sizeLimit: number;
}): Promise<{ ranBatches: number; sealedChunks: number; finalHotHead: ChunkMeta | null }> {
  const { manifestPath, outputDir, protocolId, protocol, tip, batchSize } = args;

  // 1. Resolve where to start. Take the max() of hot head's toBlock and the
  // last sealed chunk's toBlock — that's robust to a crash-post-seal-pre-clear
  // state where the hot head still points at an obsolete range.
  const lastSealed = (() => {
    const chunks = args.manifest.availableStates[protocolId];
    const last = chunks && chunks.length > 0 ? chunks[chunks.length - 1] : undefined;
    return last ? BigInt(last.toBlock) : null;
  })();

  const recordedHot = args.manifest.hotHeads?.[protocolId];
  const recordedHotTo = recordedHot ? BigInt(recordedHot.toBlock) : null;

  // Detect stale hot head: its toBlock is no further forward than what's
  // already sealed. Clear it from the manifest and unlink the file (best-effort).
  let validHot = recordedHot;
  if (recordedHot && lastSealed !== null && recordedHotTo !== null && recordedHotTo <= lastSealed) {
    process.stderr.write(
      `orchestrator: ${protocolId} — stale hot head detected (toBlock ${recordedHot.toBlock} <= sealed ${numberToHex(lastSealed)}); cleaning up\n`,
    );
    clearHotHead(manifestPath, protocolId);
    try {
      unlinkSync(join(outputDir, recordedHot.file));
    } catch {
      /* already gone or never on this disk */
    }
    validHot = undefined;
  }

  const startBlock =
    validHot && recordedHotTo !== null
      ? recordedHotTo
      : lastSealed !== null
        ? lastSealed
        : BigInt(protocol.fromBlock);

  if (startBlock > tip) {
    return { ranBatches: 0, sealedChunks: 0, finalHotHead: null };
  }

  // 2. Load the prior hot head events into memory (will be passed as the seed
  // for the first batch).
  let trailing: { events: CanonicalEvent[]; fromBlock: bigint; toBlock: bigint } | undefined;
  if (validHot) {
    const events = readChunkFile(join(outputDir, validHot.file));
    trailing = {
      events,
      fromBlock: BigInt(validHot.fromBlock),
      toBlock: BigInt(validHot.toBlock),
    };
  }
  const priorHotFile = validHot?.file ?? null;
  const sizeLimit = protocol.maxSizeBytes ?? args.sizeLimit;

  // 3. Batch loop. Each batch's trailing carries into the next as the seed.
  let batchStart = startBlock;
  let totalSealed = 0;
  let ranBatches = 0;
  while (batchStart <= tip) {
    const batchEndCandidate = batchStart + batchSize - 1n;
    const batchEnd = batchEndCandidate > tip ? tip : batchEndCandidate;

    const result = await runProtocolOnce({
      client: args.client,
      protocolId,
      fromBlock: batchStart,
      toBlock: batchEnd,
      events: protocol.events,
      sizeLimit,
      outputDir,
      window: args.window,
      ...(trailing && {
        hotHead: { events: trailing.events, fromBlock: trailing.fromBlock },
      }),
      trailingMode: "suspend",
    });
    totalSealed += result.sealed.length;
    trailing = result.trailing;
    batchStart = batchEnd + 1n;
    ranBatches += 1;
  }

  // 4. Persist the final trailing accumulator as the new hot head. Even when
  // events is empty, the range advances and the manifest needs to reflect that
  // we've scanned up to here — so a subsequent run starts from the right block.
  let finalHotHead: ChunkMeta | null = null;
  if (trailing) {
    const newHotMeta = sealChunk(
      trailing.events,
      { from: trailing.fromBlock, to: trailing.toBlock },
      { outputDir, protocolId, dryRun: false, hot: true },
    );
    setHotHead(manifestPath, protocolId, newHotMeta);
    finalHotHead = newHotMeta;

    // Delete the prior hot-head file if the new file has a different name
    // (which it does whenever the toBlock advanced — i.e., always, unless the
    // batch was a no-op).
    if (priorHotFile && priorHotFile !== newHotMeta.file) {
      try {
        unlinkSync(join(outputDir, priorHotFile));
      } catch {
        /* already gone */
      }
    }
  }

  return { ranBatches, sealedChunks: totalSealed, finalHotHead };
}

async function main(): Promise<void> {
  const args = parseCliArgs();
  const lockDir = args.lockDir ?? args.outputDir;
  if (!args.dryRun) {
    mkdirSync(args.outputDir, { recursive: true });
    mkdirSync(lockDir, { recursive: true });
  }

  // Dry-run is read-only: don't hold the lock.
  const lockPath = join(lockDir, ".orchestrator.lock");
  if (!args.dryRun && !acquireLock(lockPath)) {
    process.stderr.write(`orchestrator: another instance is running (lock ${lockPath}); exiting\n`);
    return;
  }

  const protocols = loadAllProtocols(args.configPath);
  const manifestPath = join(args.outputDir, "index.json");
  const manifest = readManifest(manifestPath);

  const client: PublicClient = createPublicClient({ transport: http(args.rpc) });
  const tip =
    (await finalizedBlock(client)) ?? (await client.getBlockNumber()) - args.confirmations;

  const ids = args.protocolId
    ? args.protocolId in protocols
      ? [args.protocolId]
      : fail(`unknown --protocol-id "${args.protocolId}". Known: ${Object.keys(protocols).join(", ")}`)
    : Object.keys(protocols);

  let ran = 0;
  let skipped = 0;
  let failed = 0;
  for (const protocolId of ids) {
    const protocol = protocols[protocolId];
    if (!protocol) continue;

    try {
      await assertChainId(client, protocol.chainId);
    } catch (err) {
      process.stderr.write(
        `orchestrator: skipping ${protocolId} — ${(err as Error).message}\n`,
      );
      skipped += 1;
      continue;
    }

    const startCovered = lastCoveredBlock(manifest, protocolId);
    const startFrom = startCovered ?? BigInt(protocol.fromBlock);
    if (startFrom > tip) {
      skipped += 1;
      continue;
    }

    if (args.dryRun) {
      process.stderr.write(
        `orchestrator: [dry-run] ${protocolId} would scan ` +
          `[${numberToHex(startFrom)}, ${numberToHex(tip)}] in ` +
          `${Math.ceil(Number((tip - startFrom + 1n) / args.batchSize)) || 1} batch(es)\n`,
      );
      ran += 1;
      continue;
    }

    try {
      // Re-read manifest in case a previous protocol mutated it this tick.
      const freshManifest = readManifest(manifestPath);
      const result = await processProtocol({
        client,
        protocolId,
        protocol,
        outputDir: args.outputDir,
        manifestPath,
        manifest: freshManifest,
        tip,
        batchSize: args.batchSize,
        window: args.window,
        sizeLimit: args.sizeLimit,
      });
      const hotSummary = result.finalHotHead
        ? ` + hot head [${result.finalHotHead.fromBlock}, ${result.finalHotHead.toBlock})`
        : "";
      process.stderr.write(
        `orchestrator: ${protocolId} ran ${result.ranBatches} batch(es), sealed ${result.sealedChunks} chunk(s)` +
          `${hotSummary}\n`,
      );
      ran += 1;
    } catch (err) {
      process.stderr.write(
        `orchestrator: ${protocolId} failed — ${(err as Error).message}\n`,
      );
      failed += 1;
    }
  }

  process.stderr.write(
    `orchestrator: ${ran} ran, ${skipped} skipped, ${failed} failed [tip ${numberToHex(tip)}]` +
      (args.dryRun ? " (dry-run)\n" : "\n"),
  );
  if (failed > 0) process.exit(2);
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

// Exports for testing
export { main, parseCliArgs, processProtocol };
