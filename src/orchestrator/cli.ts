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
import { createStore, parseStoreTarget } from "../storage/index.js";
import { Manifest } from "../chunk-builder/manifest.js";
import { signerFromEnv } from "../signing.js";
import type { ChunkMeta } from "../chunk-builder/manifest.js";
import { ChunkArchive } from "../chunk-builder/archive.js";
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
    output: need("output-dir"), // raw — may be a local dir or a gs:// target
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
// lock, false if another live process already holds it. Disk-only by design —
// the lock is a local single-machine coordination primitive, not object storage.
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

      let stalePid: number;
      try {
        stalePid = parseInt(readFileSync(path, "utf8").trim(), 10);
      } catch {
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
        return false; // owner alive
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
        return false; // EPERM: exists but unsignalable — treat as alive
      }
    }
  }
  return false;
}

// Process one protocol: clean any stale hot head, loop in batches, persist the
// final trailing accumulator as the new hot head.
async function processProtocol(args: {
  client: PublicClient;
  protocolId: string;
  protocol: ScraperTarget;
  archive: ChunkArchive;
  manifest: Manifest;
  tip: bigint;
  batchSize: bigint;
  window: number;
  sizeLimit: number;
}): Promise<{ ranBatches: number; sealedChunks: number; finalHotHead: ChunkMeta | null }> {
  const { manifest, archive, protocolId, protocol, tip, batchSize } = args;

  // 1. Resolve where to start. Take the max() of the hot head's toBlock and the
  // last sealed chunk's toBlock — robust to a crash-post-seal-pre-clear state.
  const sealedChunks = manifest.sealedChunks(protocolId);
  const lastSealedChunk = sealedChunks.length > 0 ? sealedChunks[sealedChunks.length - 1] : undefined;
  const lastSealed = lastSealedChunk ? BigInt(lastSealedChunk.toBlock) : null;

  const recordedHot = manifest.hotHead(protocolId);
  const recordedHotTo = recordedHot ? BigInt(recordedHot.toBlock) : null;

  // Stale hot head: its toBlock is no further forward than what's already
  // sealed. Clear it from the manifest and delete the file (best-effort).
  let validHot = recordedHot;
  if (recordedHot && lastSealed !== null && recordedHotTo !== null && recordedHotTo <= lastSealed) {
    process.stderr.write(
      `orchestrator: ${protocolId} — stale hot head (toBlock ${recordedHot.toBlock} <= sealed ${numberToHex(lastSealed)}); cleaning up\n`,
    );
    await manifest.clearHotHead(protocolId);
    await archive.delete(recordedHot);
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

  // 2. Load the prior hot head's events — the seed for the first batch.
  let trailing: { events: Awaited<ReturnType<ChunkArchive["readEvents"]>>; fromBlock: bigint } | undefined;
  if (validHot) {
    trailing = {
      events: await archive.readEvents(validHot),
      fromBlock: BigInt(validHot.fromBlock),
    };
  }
  const sizeLimit = protocol.maxSizeBytes ?? args.sizeLimit;

  // 3. Batch loop. Each batch's trailing carries into the next as the seed.
  let batchStart = startBlock;
  let totalSealed = 0;
  let ranBatches = 0;
  while (batchStart <= tip) {
    const candidate = batchStart + batchSize - 1n;
    const batchEnd = candidate > tip ? tip : candidate;

    const result = await runProtocolOnce({
      client: args.client,
      protocolId,
      fromBlock: batchStart,
      toBlock: batchEnd,
      events: protocol.events,
      sizeLimit,
      window: args.window,
      archive,
      manifest,
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
  // events is empty the range advances, so the manifest must reflect it.
  let finalHotHead: ChunkMeta | null = null;
  if (trailing) {
    const trailingState = trailing;
    finalHotHead = await archive.writeHotHead(protocolId, trailingState.events, {
      from: trailingState.fromBlock,
      to: tip + 1n,
    });
    await manifest.setHotHead(protocolId, finalHotHead);

    // Delete the prior hot-head file if the new file has a different name
    // (it does whenever the range advanced — i.e., always, unless a no-op tick).
    if (validHot && validHot.file !== finalHotHead.file) {
      await archive.delete(validHot);
    }
  }

  return { ranBatches, sealedChunks: totalSealed, finalHotHead };
}

async function main(): Promise<void> {
  const args = parseCliArgs();
  const storeConfig = parseStoreTarget(args.output);
  // The lockfile is filesystem-only. For a local output dir it lives there; for a
  // gs:// target there is no local dir, so default to the cwd (override with
  // --lock-dir). (On Cloud Run, single-execution scheduling is the real guard.)
  const lockDir =
    args.lockDir ?? (storeConfig.protocol === "disk" ? storeConfig.baseDir! : resolve("."));

  // Dry-run is read-only: don't create dirs or hold the lock.
  if (!args.dryRun) {
    mkdirSync(lockDir, { recursive: true });
    const lockPath = join(lockDir, ".orchestrator.lock");
    if (!acquireLock(lockPath)) {
      process.stderr.write(
        `orchestrator: another instance is running (lock ${lockPath}); exiting\n`,
      );
      return;
    }
  }

  const protocols = loadAllProtocols(args.configPath);
  const store = createStore({ ...storeConfig, dryRun: args.dryRun });
  const archive = new ChunkArchive(store);
  const manifest = await Manifest.load(store, undefined, { signer: signerFromEnv() });

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
      process.stderr.write(`orchestrator: skipping ${protocolId} — ${(err as Error).message}\n`);
      skipped += 1;
      continue;
    }

    const startFrom = manifest.lastCoveredBlock(protocolId) ?? BigInt(protocol.fromBlock);
    if (startFrom > tip) {
      skipped += 1;
      continue;
    }

    if (args.dryRun) {
      const batches = Math.ceil(Number((tip - startFrom + 1n) / args.batchSize)) || 1;
      process.stderr.write(
        `orchestrator: [dry-run] ${protocolId} would scan ` +
          `[${numberToHex(startFrom)}, ${numberToHex(tip)}] in ${batches} batch(es)\n`,
      );
      ran += 1;
      continue;
    }

    try {
      const result = await processProtocol({
        client,
        protocolId,
        protocol,
        archive,
        manifest,
        tip,
        batchSize: args.batchSize,
        window: args.window,
        sizeLimit: args.sizeLimit,
      });
      const hot = result.finalHotHead
        ? ` + hot head [${result.finalHotHead.fromBlock}, ${result.finalHotHead.toBlock})`
        : "";
      process.stderr.write(
        `orchestrator: ${protocolId} ran ${result.ranBatches} batch(es), ` +
          `sealed ${result.sealedChunks} chunk(s)${hot}\n`,
      );
      ran += 1;
    } catch (err) {
      process.stderr.write(`orchestrator: ${protocolId} failed — ${(err as Error).message}\n`);
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

export { main, parseCliArgs, processProtocol };
