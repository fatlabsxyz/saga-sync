#!/usr/bin/env node
import { parseArgs } from "node:util";
import { dirname, resolve } from "node:path";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createPublicClient, http, numberToHex } from "viem";
import type { Hex, PublicClient } from "viem";
import { loadConfig } from "./config.js";
import { readCursor, writeCursor } from "./cursor.js";
import { scrape } from "./scrape.js";
import { normalize } from "./normalize.js";

const DEFAULT_WINDOW = 2000;
const DEFAULT_CONFIRMATIONS = 12n;

const USAGE = `scraper — fetch and normalize privacy-protocol events to NDJSON on stdout

Usage:
  scraper --config <path> --protocol-id <id> --rpc <url> [options]

Required:
  --config <path>        scraper config JSON
  --protocol-id <id>     key in config.protocols to scrape
  --rpc <url>            Ethereum JSON-RPC URL

Options:
  --from-block <hex>     override cursor / config fromBlock (e.g. for backfills)
  --to-block <hex>       override the resolved finalized/head block
  --confirmations <n>    fallback reorg buffer, default 12 (used only when the RPC
                         does not support the "finalized" block tag)
  --window <n>           blocks per eth_getLogs call, default 2000
  --cursor-dir <path>    directory for cursor.json, default = config file's directory
  --dry-run              do not persist the cursor update
  --help                 show this message
`;

function fail(msg: string): never {
  process.stderr.write(`scraper: ${msg}\n`);
  process.exit(1);
}

function parseCliArgs() {
  const { values } = parseArgs({
    options: {
      config: { type: "string" },
      "protocol-id": { type: "string" },
      rpc: { type: "string" },
      "from-block": { type: "string" },
      "to-block": { type: "string" },
      confirmations: { type: "string" },
      window: { type: "string" },
      "cursor-dir": { type: "string" },
      "dry-run": { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  });

  if (values.help) {
    process.stdout.write(USAGE);
    process.exit(0);
  }

  const need = (name: "config" | "protocol-id" | "rpc"): string => {
    const v = values[name];
    if (!v) fail(`missing required --${name}\n\n${USAGE}`);
    return v;
  };

  const configPath = resolve(need("config"));

  return {
    configPath,
    protocolId: need("protocol-id"),
    rpc: need("rpc"),
    fromBlock: values["from-block"] ? BigInt(values["from-block"]) : undefined,
    toBlock: values["to-block"] ? BigInt(values["to-block"]) : undefined,
    confirmations: values.confirmations ? BigInt(values.confirmations) : DEFAULT_CONFIRMATIONS,
    window: values.window ? Number(values.window) : DEFAULT_WINDOW,
    cursorPath: resolve(values["cursor-dir"] ?? dirname(configPath), "cursor.json"),
    dryRun: values["dry-run"] ?? false,
  };
}

// The chain's own finalized block — reorg-proof, no per-chain table needed.
// Returns null if the RPC/chain does not support the "finalized" tag, which
// triggers the --confirmations fallback in step 2.
export async function finalizedBlock(client: PublicClient): Promise<bigint | null> {
  try {
    const block = await client.getBlock({ blockTag: "finalized" });
    return block.number;
  } catch {
    return null;
  }
}

// Verify the RPC is actually on the chain the config declares — catches a
// misconfigured --rpc pointed at the wrong network before any data is emitted.
export async function assertChainId(client: PublicClient, expected: Hex): Promise<void> {
  const actual = await client.getChainId();
  if (BigInt(actual) !== BigInt(expected)) {
    throw new Error(
      `chain mismatch: config declares chainId ${expected}, but the RPC reports ${numberToHex(actual)}`,
    );
  }
}

async function main(): Promise<void> {
  const args = parseCliArgs();
  const config = loadConfig(args.configPath, args.protocolId);
  const cursor = readCursor(args.cursorPath);

  // 1. Connect to the RPC (and verify it is on the chain the config declares)
  const client = createPublicClient({ transport: http(args.rpc) });
  await assertChainId(client, config.chainId);

  // 2. Resolve the block range to scan
  const toBlock =
    args.toBlock ??
    (await finalizedBlock(client)) ??
    (await client.getBlockNumber()) - args.confirmations;

  const cursorEntry = cursor[args.protocolId];
  const fromBlock =
    args.fromBlock ??
    (cursorEntry ? BigInt(cursorEntry.lastScrapedBlock) + 1n : undefined) ??
    BigInt(config.fromBlock);

  if (fromBlock > toBlock) {
    process.stderr.write(
      `scraper: nothing to do — fromBlock ${numberToHex(fromBlock)} > toBlock ${numberToHex(toBlock)}\n`,
    );
    return;
  }

  // 3. Fetch logs (windowed, streaming)  +  4. Normalize  +  5. Emit
  let count = 0;
  for await (const log of scrape(client, {
    fromBlock,
    toBlock,
    events: config.events,
    window: args.window,
  })) {
    process.stdout.write(JSON.stringify(normalize(log)) + "\n");
    count += 1;
  }

  // persist progress — one cursor update per successful run
  if (!args.dryRun) {
    writeCursor(args.cursorPath, args.protocolId, numberToHex(toBlock));
  }
  process.stderr.write(
    `scraper: ${count} event(s) for ${args.protocolId} ` +
      `[${numberToHex(fromBlock)}, ${numberToHex(toBlock)}]` +
      (args.dryRun ? " (dry-run: cursor not updated)\n" : "\n"),
  );
}

// Only run the pipeline when invoked as the entry point — importing this module
// (e.g. from tests) must not kick off a scrape.
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
