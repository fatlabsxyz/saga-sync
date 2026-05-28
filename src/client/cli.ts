#!/usr/bin/env node
import { parseArgs } from "node:util";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { numberToHex } from "viem";
import { HttpStore, DiskStore } from "../storage/index.js";
import { Client } from "./client.js";

const DEFAULT_CONCURRENCY = 4;

const USAGE = `state-client — download + verify a protocol's published state, emit NDJSON

Usage:
  state-client --manifest-url <url> --protocol-id <id> [options]

Required:
  --manifest-url <url>   base URL of the published state (manifest at <url>/index.json)
  --protocol-id <id>     protocol key to stream

Options:
  --cache-dir <path>     local directory to cache verified sealed chunks
                         (re-runs only re-fetch the hot head + any new chunks)
  --from-block <hex>     skip chunks ending at or before this block
  --to-block <hex>       skip chunks starting at or after this block
  --concurrency <n>      parallel chunk fetches, default ${DEFAULT_CONCURRENCY}
  --help                 show this message
`;

function fail(msg: string): never {
  process.stderr.write(`state-client: ${msg}\n`);
  process.exit(1);
}

function parseCliArgs() {
  const { values } = parseArgs({
    options: {
      "manifest-url": { type: "string" },
      "protocol-id": { type: "string" },
      "cache-dir": { type: "string" },
      "from-block": { type: "string" },
      "to-block": { type: "string" },
      concurrency: { type: "string" },
      help: { type: "boolean", default: false },
    },
  });

  if (values.help) {
    process.stdout.write(USAGE);
    process.exit(0);
  }

  const need = (name: "manifest-url" | "protocol-id"): string => {
    const v = values[name];
    if (!v) fail(`missing required --${name}\n\n${USAGE}`);
    return v;
  };

  const concurrency = values.concurrency ? Number(values.concurrency) : DEFAULT_CONCURRENCY;
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    fail(`--concurrency must be a positive integer; got ${values.concurrency}`);
  }

  return {
    manifestUrl: need("manifest-url"),
    protocolId: need("protocol-id"),
    cacheDir: values["cache-dir"] ? resolve(values["cache-dir"]) : undefined,
    fromBlock: values["from-block"] ? BigInt(values["from-block"]) : undefined,
    toBlock: values["to-block"] ? BigInt(values["to-block"]) : undefined,
    concurrency,
  };
}

async function main(): Promise<void> {
  const args = parseCliArgs();

  const source = new HttpStore(args.manifestUrl);
  const cache = args.cacheDir ? new DiskStore(args.cacheDir) : undefined;
  const client = new Client({ source, cache, concurrency: args.concurrency });

  const stream = client.streamEvents(args.protocolId, {
    fromBlock: args.fromBlock,
    toBlock: args.toBlock,
  });

  let count = 0;
  for await (const event of stream) {
    process.stdout.write(JSON.stringify(event) + "\n");
    count++;
  }

  const range =
    args.fromBlock !== undefined || args.toBlock !== undefined
      ? ` in [${args.fromBlock !== undefined ? numberToHex(args.fromBlock) : "*"},` +
        `${args.toBlock !== undefined ? numberToHex(args.toBlock) : "*"})`
      : "";
  process.stderr.write(
    `state-client: ${count} event(s) for ${args.protocolId}${range}` +
      (args.cacheDir ? ` (cache=${args.cacheDir})` : "") +
      `\n`,
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
