#!/usr/bin/env node
import { parseArgs } from "node:util";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { numberToHex } from "viem";
import { HttpStore, DiskStore } from "../storage/index.js";
import type { ChunkMeta } from "../chunk-builder/manifest.js";
import { Client } from "./client.js";
import { selectSealedChunks, selectHotHead } from "./manifest.js";
import { humanBytes, table } from "./format.js";

const DEFAULT_CONCURRENCY = 4;

const USAGE = `state-client — inspect + download a protocol's published state

Usage:
  state-client <command> <manifest-url> [<protocol-id>] [options]

Commands:
  protocols <manifest-url>                list every protocol + summary   (alias: ls)
  info      <manifest-url> <protocol-id>  detailed summary for one protocol
  head      <manifest-url> <protocol-id>  latest covered block / freshness (alias: latest)
  chunks    <manifest-url> <protocol-id>  list this protocol's chunks
  stream    <manifest-url> <protocol-id>  download + verify + emit NDJSON

The manifest is read from <manifest-url>/index.json. The query commands
(protocols/info/head/chunks) fetch only the manifest — no chunk downloads.

Options:
  --json                 machine-readable output instead of human tables
  --from-block <hex>     info/chunks/stream: lower bound of the block range
  --to-block <hex>       info/chunks/stream: upper bound (exclusive)
  --since-block <hex>    head: exit 3 if no block beyond this is covered
  --hot                  chunks: include the mutable hot head
  --cache-dir <path>     stream: local cache of verified sealed chunks
  --concurrency <n>      stream: parallel chunk fetches, default ${DEFAULT_CONCURRENCY}
  --help                 show this message

Exit codes: 0 ok · 1 usage/fetch/not-found · 3 head --since-block found nothing newer
`;

function fail(msg: string): never {
  process.stderr.write(`state-client: ${msg}\n`);
  process.exit(1);
}

function hexOrNull(b: bigint | null): string | null {
  return b === null ? null : numberToHex(b);
}

// Sum the compressed `size` of a chunk list plus an optional hot head.
function sumSize(chunks: ChunkMeta[], hot?: ChunkMeta): bigint {
  let total = chunks.reduce((s, c) => s + BigInt(c.size), 0n);
  if (hot) total += BigInt(hot.size);
  return total;
}

type Range = { fromBlock?: bigint; toBlock?: bigint };

// --- command handlers: each fetches the manifest and returns rendered output,
//     so they are unit-testable against an in-memory Store without a process. ---

export async function cmdProtocols(client: Client, opts: { json: boolean }): Promise<string> {
  const manifest = await client.fetchManifest();
  const rows = manifest.protocolIds().map((id) => {
    const sealed = manifest.sealedChunks(id);
    const hot = manifest.hotHead(id);
    return {
      protocolId: id,
      sealedChunks: sealed.length,
      fromBlock: hexOrNull(manifest.firstCoveredBlock(id)),
      lastCoveredBlock: hexOrNull(manifest.lastCoveredBlock(id)),
      hotHead: hot !== undefined,
      totalSize: numberToHex(sumSize(sealed, hot)),
    };
  });
  if (opts.json) return JSON.stringify(rows, null, 2);
  if (rows.length === 0) return "(no protocols in manifest)";
  return table(
    ["PROTOCOL", "CHUNKS", "RANGE", "HOT", "SIZE"],
    rows.map((r) => [
      r.protocolId,
      String(r.sealedChunks),
      `${r.fromBlock ?? "-"} → ${r.lastCoveredBlock ?? "-"}`,
      r.hotHead ? "yes" : "no",
      humanBytes(BigInt(r.totalSize)),
    ]),
  );
}

export async function cmdInfo(
  client: Client,
  id: string,
  opts: { json: boolean } & Range,
): Promise<string> {
  const manifest = await client.fetchManifest();
  if (!manifest.protocolIds().includes(id)) throw new Error(`unknown protocol "${id}"`);
  const sealed = manifest.sealedChunks(id);
  const hot = manifest.hotHead(id);
  const range: Range = { fromBlock: opts.fromBlock, toBlock: opts.toBlock };
  const scopedSize = sumSize(selectSealedChunks(sealed, range), selectHotHead(hot, range));
  const gaps = manifest.gaps(id);
  const first = manifest.firstCoveredBlock(id);
  const last = manifest.lastCoveredBlock(id);

  if (opts.json) {
    return JSON.stringify(
      {
        protocolId: id,
        fromBlock: hexOrNull(first),
        lastCoveredBlock: hexOrNull(last),
        sealedChunks: sealed.length,
        hotHead: hot ? { fromBlock: hot.fromBlock, toBlock: hot.toBlock, size: hot.size } : null,
        totalCompressedSize: numberToHex(scopedSize),
        gaps,
      },
      null,
      2,
    );
  }

  const ranged = opts.fromBlock !== undefined || opts.toBlock !== undefined;
  return [
    `protocol:        ${id}`,
    `block range:     ${hexOrNull(first) ?? "-"} → ${hexOrNull(last) ?? "-"}`,
    `sealed chunks:   ${sealed.length}`,
    `hot head:        ${hot ? `${hot.fromBlock} → ${hot.toBlock} (${humanBytes(BigInt(hot.size))})` : "none"}`,
    `download size:   ${humanBytes(scopedSize)}${ranged ? " (for requested range)" : ""}`,
    `contiguity:      ${
      gaps.length === 0
        ? "gapless"
        : `${gaps.length} gap(s): ${gaps.map((g) => `[${g.from},${g.to})`).join(", ")}`
    }`,
  ].join("\n");
}

export async function cmdHead(
  client: Client,
  id: string,
  opts: { json: boolean; sinceBlock?: bigint },
): Promise<{ text: string; stale: boolean }> {
  const manifest = await client.fetchManifest();
  if (!manifest.protocolIds().includes(id)) throw new Error(`unknown protocol "${id}"`);
  const last = manifest.lastCoveredBlock(id);
  const hot = manifest.hotHead(id);
  const stale = opts.sinceBlock !== undefined && (last === null || last <= opts.sinceBlock);

  if (opts.json) {
    const text = JSON.stringify(
      {
        lastCoveredBlock: hexOrNull(last),
        hotHead: hot ? { fromBlock: hot.fromBlock, toBlock: hot.toBlock } : null,
      },
      null,
      2,
    );
    return { text, stale };
  }

  const lines = [`last covered block: ${hexOrNull(last) ?? "-"}`];
  if (hot) lines.push(`hot head:           ${hot.fromBlock} → ${hot.toBlock}`);
  if (opts.sinceBlock !== undefined) {
    lines.push(
      stale
        ? `no new data since ${numberToHex(opts.sinceBlock)}`
        : `new data beyond ${numberToHex(opts.sinceBlock)}`,
    );
  }
  return { text: lines.join("\n"), stale };
}

export async function cmdChunks(
  client: Client,
  id: string,
  opts: { json: boolean; hot: boolean } & Range,
): Promise<string> {
  const manifest = await client.fetchManifest();
  if (!manifest.protocolIds().includes(id)) throw new Error(`unknown protocol "${id}"`);
  const range: Range = { fromBlock: opts.fromBlock, toBlock: opts.toBlock };
  const list: ChunkMeta[] = [...selectSealedChunks(manifest.sealedChunks(id), range)];
  if (opts.hot) {
    const h = selectHotHead(manifest.hotHead(id), range);
    if (h) list.push(h);
  }
  if (opts.json) return JSON.stringify(list, null, 2);
  if (list.length === 0) return "(no chunks in range)";
  return table(
    ["RANGE", "SIZE", "FILE", "DIGEST"],
    list.map((c) => [
      `[${c.fromBlock},${c.toBlock})`,
      humanBytes(BigInt(c.size)),
      c.file,
      c.digest.data,
    ]),
  );
}

async function runStream(
  manifestUrl: string,
  id: string,
  opts: { cacheDir?: string; concurrency: number } & Range,
): Promise<void> {
  const source = new HttpStore(manifestUrl);
  const cache = opts.cacheDir ? new DiskStore(opts.cacheDir) : undefined;
  const client = new Client({ source, cache, concurrency: opts.concurrency });

  let count = 0;
  for await (const event of client.streamEvents(id, {
    fromBlock: opts.fromBlock,
    toBlock: opts.toBlock,
  })) {
    process.stdout.write(JSON.stringify(event) + "\n");
    count++;
  }

  const range =
    opts.fromBlock !== undefined || opts.toBlock !== undefined
      ? ` in [${opts.fromBlock !== undefined ? numberToHex(opts.fromBlock) : "*"},` +
        `${opts.toBlock !== undefined ? numberToHex(opts.toBlock) : "*"})`
      : "";
  process.stderr.write(
    `state-client: ${count} event(s) for ${id}${range}` +
      (opts.cacheDir ? ` (cache=${opts.cacheDir})` : "") +
      `\n`,
  );
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      json: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
      "cache-dir": { type: "string" },
      "from-block": { type: "string" },
      "to-block": { type: "string" },
      "since-block": { type: "string" },
      hot: { type: "boolean", default: false },
      concurrency: { type: "string" },
    },
  });

  if (values.help || positionals.length === 0) {
    process.stdout.write(USAGE);
    return;
  }

  const [command, manifestUrl] = positionals;
  if (!manifestUrl) fail(`missing <manifest-url>\n\n${USAGE}`);

  const json = values.json;
  const range: Range = {
    fromBlock: values["from-block"] ? BigInt(values["from-block"]) : undefined,
    toBlock: values["to-block"] ? BigInt(values["to-block"]) : undefined,
  };
  const needId = (): string => {
    const id = positionals[2];
    if (!id) fail(`missing <protocol-id> for "${command}"\n\n${USAGE}`);
    return id;
  };
  const queryClient = (): Client => new Client({ source: new HttpStore(manifestUrl) });

  switch (command) {
    case "protocols":
    case "ls":
      process.stdout.write((await cmdProtocols(queryClient(), { json })) + "\n");
      return;
    case "info":
      process.stdout.write((await cmdInfo(queryClient(), needId(), { json, ...range })) + "\n");
      return;
    case "head":
    case "latest": {
      const sinceBlock = values["since-block"] ? BigInt(values["since-block"]) : undefined;
      const res = await cmdHead(queryClient(), needId(), { json, sinceBlock });
      process.stdout.write(res.text + "\n");
      if (res.stale) process.exit(3);
      return;
    }
    case "chunks":
      process.stdout.write(
        (await cmdChunks(queryClient(), needId(), { json, hot: values.hot, ...range })) + "\n",
      );
      return;
    case "stream": {
      const concurrency = values.concurrency ? Number(values.concurrency) : DEFAULT_CONCURRENCY;
      if (!Number.isInteger(concurrency) || concurrency < 1) {
        fail(`--concurrency must be a positive integer; got ${values.concurrency}`);
      }
      await runStream(manifestUrl, needId(), {
        cacheDir: values["cache-dir"] ? resolve(values["cache-dir"]) : undefined,
        concurrency,
        ...range,
      });
      return;
    }
    default:
      fail(`unknown command "${command}"\n\n${USAGE}`);
  }
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
