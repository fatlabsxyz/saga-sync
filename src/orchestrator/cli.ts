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
import { readManifest } from "../chunk-builder/manifest.js";
import type { Manifest } from "../chunk-builder/manifest.js";
import { runProtocolOnce } from "./pipeline.js";

const DEFAULT_WINDOW = 2000;
const DEFAULT_CONFIRMATIONS = 12n;
const DEFAULT_SIZE_LIMIT = 10 * 1024 * 1024;

const USAGE = `orchestrator — run scrape→chunk for every due protocol

Usage:
  orchestrator --config <path> --rpc <url> --output-dir <path> [options]

Required:
  --config <path>        scraper config JSON (all protocols read)
  --rpc <url>            Ethereum JSON-RPC URL (single chain per run)
  --output-dir <path>    chunks + index.json directory

Options:
  --lock-dir <path>      directory for .orchestrator.lock; default = output-dir
  --protocol-id <id>     restrict to one protocol (backfills / ad-hoc runs)
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

  return {
    configPath: resolve(need("config")),
    rpc: need("rpc"),
    outputDir: resolve(need("output-dir")),
    lockDir: values["lock-dir"] ? resolve(values["lock-dir"]) : undefined,
    protocolId: values["protocol-id"],
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

export function lastChunkToBlock(manifest: Manifest, protocolId: string): bigint | null {
  const chunks = manifest.availableStates[protocolId];
  if (!chunks || chunks.length === 0) return null;
  const last = chunks[chunks.length - 1];
  if (!last) return null;
  return BigInt(last.toBlock);
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
  const manifest = readManifest(join(args.outputDir, "index.json"));

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

    const fromBlock = lastChunkToBlock(manifest, protocolId) ?? BigInt(protocol.fromBlock);
    const toBlock = tip;
    if (fromBlock > toBlock) {
      skipped += 1;
      continue;
    }

    if (args.dryRun) {
      process.stderr.write(
        `orchestrator: [dry-run] ${protocolId} would scan ` +
          `[${numberToHex(fromBlock)}, ${numberToHex(toBlock)}]\n`,
      );
      ran += 1;
      continue;
    }

    try {
      const sealed = await runProtocolOnce({
        client,
        protocolId,
        fromBlock,
        toBlock,
        events: protocol.events,
        sizeLimit: protocol.maxSizeBytes ?? args.sizeLimit,
        outputDir: args.outputDir,
        window: args.window,
      });
      process.stderr.write(
        `orchestrator: ${protocolId} sealed ${sealed.length} chunk(s) ` +
          `[${numberToHex(fromBlock)}, ${numberToHex(toBlock + 1n)})\n`,
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
export { main, parseCliArgs };
