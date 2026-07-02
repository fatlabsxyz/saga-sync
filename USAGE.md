# Scraper + Chunk Builder + Orchestrator — usage

Quick reference for the three CLIs in the pipeline. For day-to-day operation, skip ahead to **Orchestrator CLI** — it wraps both the scraper and the chunk builder behind a single command. The earlier sections document the scraper and chunk builder as standalone tools (useful for backfills, debugging, or composing manually).

## One-time setup

```bash
pnpm install
pnpm build
```

## Basic invocation

Run from the repo root, scrapes a small Tornado Cash range and emits the events as NDJSON on stdout:

```bash
node packages/producer/dist/scraper/cli.js \
  --config ./example-config.json \
  --protocol-id tornado-cash-1-eth-0.1 \
  --rpc https://ethereum-rpc.publicnode.com \
  --from-block 0xC50101 --to-block 0xC50200 \
  --dry-run
```

Emits 2 NDJSON lines on stdout and a one-line summary on stderr:

```
scraper: 2 event(s) for tornado-cash-1-eth-0.1 [0xc50101, 0xc50200] (dry-run: cursor not updated)
```

## Useful variations

**Persist a cursor** (drop `--dry-run`) — next run with no `--from-block` resumes from `cursor + 1`:

```bash
node packages/producer/dist/scraper/cli.js --config ./example-config.json --protocol-id tornado-cash-1-eth-0.1 \
  --rpc https://ethereum-rpc.publicnode.com --from-block 0xC50000 --to-block 0xC50100
cat cursor.json   # → { "tornado-cash-1-eth-0.1": { "lastScrapedBlock": "0xc50100" } }
```

**Scrape up to the chain's finalized block** (omit `--to-block`):

```bash
node packages/producer/dist/scraper/cli.js --config ./example-config.json --protocol-id tornado-cash-1-eth-0.1 \
  --rpc https://ethereum-rpc.publicnode.com --from-block 0xC50101 --dry-run
```

**Pipe to `jq` to inspect:**

```bash
node packages/producer/dist/scraper/cli.js ... --dry-run | jq -c '{block: .blockNumber, topic: .eventTopic, tx: .transactionHash}'
```

**Full flag list:**

```bash
node packages/producer/dist/scraper/cli.js --help
```

## How cron would run it (manual approach)

For most cron deployments, prefer the **orchestrator** (see bottom of this file) — it handles every protocol and updates the manifest from one entry. The manual pipe shown here is useful if you want to run a single protocol with explicit block ranges or compose your own scheduling. Output goes to stdout, summary to stderr, exit code 0 on success / 1 on error — so it's safe to pipe stdout into the chunk builder:

```bash
*/5 * * * * cd /path/to/repo && node packages/producer/dist/scraper/cli.js --config ./example-config.json \
  --protocol-id tornado-cash-1-eth-0.1 --rpc https://ethereum-rpc.publicnode.com \
  | node packages/producer/dist/chunk-builder/cli.js --protocol-id tornado-cash-1-eth-0.1 \
      --from-block 0xC50101 --to-block 0xC50201 --output-dir ./chunks \
      >> /var/log/state.log 2>&1
```

# Chunk builder CLI — usage

Reads NDJSON from stdin (one `CanonicalEvent` per line, scraper output), partitions
the scanned block range into immutable `.jsonl.gz` chunks, and appends to a local
`index.json` manifest.

## Basic invocation

Pipe the scraper directly:

```bash
node packages/producer/dist/scraper/cli.js --config ./example-config.json --protocol-id tornado-cash-1-eth-0.1 \
  --rpc https://ethereum-rpc.publicnode.com --from-block 0xC50101 --to-block 0xC50200 --dry-run \
| node packages/producer/dist/chunk-builder/cli.js \
    --protocol-id tornado-cash-1-eth-0.1 \
    --from-block 0xC50101 --to-block 0xC50201 \
    --output-dir ./chunks
```

Note the upper bound. The scraper's `--to-block` is **inclusive** (`[from, to]`);
the chunk builder's is **exclusive** (`[from, to)`). To cover the same range, pass
`scraper.to_block + 1` to the chunk builder.

Output:

```
./chunks/
  tornado-cash-1-eth-0.1-[0xc50101,0xc50201).jsonl.gz
  index.json
```

## Manifest shape

```json
{
  "version": 2,
  "availableProtocols": {
    "tornado-cash-1-eth-0.1": {
      "protocol": "tornado-cash",
      "protocolMetadata": { "denomination": "100000000000000000", "asset": "ETH" },
      "chainId": "0x1",
      "trackedAddresses": ["0x12d66f87a04a9e220743712ce6d9bb1b5616b8fc"],
      "chunks": [
        {
          "fromBlock": "0xc50101",
          "toBlock": "0xc50201",
          "file": "tornado-cash-1-eth-0.1-[0xc50101,0xc50201).jsonl.gz",
          "size": "0x23e",
          "digest": {
            "type": "sha256",
            "data": "0xa757e92468fa95659cf0189440207540a5f9363b44d8d1b6a652af7acb49a48e"
          }
        }
      ]
    }
  }
}
```

- `size`: compressed bytes (the actual file on disk).
- `digest.data`: blake3 of the **uncompressed** JSONL bytes — verify by `gunzip | blake3`.

## Useful variations

**Force multiple chunks** (set a small `--size-limit`):

```bash
node packages/producer/dist/scraper/cli.js ... | node packages/producer/dist/chunk-builder/cli.js \
  --protocol-id tornado-cash-1-eth-0.1 \
  --from-block 0xC50000 --to-block 0xC50501 \
  --output-dir ./chunks --size-limit 800
```

Chunks compose contiguously: each entry's `toBlock` equals the next entry's `fromBlock`.

**Inspect a chunk:**

```bash
gunzip -c './chunks/tornado-cash-1-eth-0.1-[0xc50101,0xc50201).jsonl.gz' | jq -c .
```

**Verify chunk integrity against the manifest:**

```bash
node --input-type=module -e "
import { blake3 } from '@noble/hashes/blake3.js';
import { gunzipSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
const idx = JSON.parse(readFileSync('./chunks/index.json', 'utf8'));
const entry = idx.availableProtocols['tornado-cash-1-eth-0.1'].chunks[0];
const data = gunzipSync(readFileSync('./chunks/' + entry.file));
const got = '0x' + Buffer.from(blake3(data)).toString('hex');
console.log(got === entry.digest.data ? 'OK' : 'MISMATCH', got);
"
```

**Dry-run** (compute metadata, don't touch disk):

```bash
node packages/producer/dist/scraper/cli.js ... --dry-run | node packages/producer/dist/chunk-builder/cli.js \
  --protocol-id tornado-cash-1-eth-0.1 \
  --from-block 0xC50101 --to-block 0xC50201 \
  --output-dir ./chunks --dry-run
```

**Empty range** (no events): the chunk builder still emits one zero-byte chunk
covering the full `[from, to)`, so the manifest asserts the range was scanned.

**Full flag list:**

```bash
node packages/producer/dist/chunk-builder/cli.js --help
```

# Orchestrator CLI — usage

Top-level cron entry point. Loads every protocol from the config, computes each one's next-from-block from the manifest (sealed chunks + mutable hot head), and loops `scrape → chunk` in **batches** of `--batch-size` blocks (default 100K). Within each tick: protocols run sequentially, a lockfile prevents accidental overlapping runs, and the trailing partial chunk after each batch is persisted as the protocol's **hot head** rather than sealed — so subsequent ticks fold new events into the existing hot head until it reaches the size limit and gets promoted into the immutable list.

## Basic invocation

```bash
node packages/producer/dist/orchestrator/cli.js \
  --config ./example-config.json \
  --rpc https://ethereum-rpc.publicnode.com \
  --output-dir ./chunks
```

stderr summary on a cold-start with a forced-promotion size limit:

```
orchestrator: tornado-cash-1-eth-0.1 ran 3 batch(es), sealed 14 chunk(s) + hot head [0x17f76ce, 0x17f7803)
orchestrator: 1 ran, 0 skipped, 0 failed [tip 0x17f7802]
```

## What gets created

```
./chunks/
  tornado-cash-1-eth-0.1-[0x17f7000,0x17f71f3).jsonl.gz      # immutable sealed chunks
  tornado-cash-1-eth-0.1-[0x17f71f3,0x17f7204).jsonl.gz
  ...
  tornado-cash-1-eth-0.1-[0x17f76ce,0x17f7803).hot.jsonl.gz  # mutable hot head (one per protocol)
  index.json
  .orchestrator.lock                                          # only present during a run
```

- Sealed chunks (`*.jsonl.gz`) are **immutable at their URL** — safe to cache forever.
- The hot head file (`*.hot.jsonl.gz`) is also immutable at its URL, but the manifest's `hotHeads[id].file` points at a new URL on each tick that advances the hot head's range. The previous hot-head file is deleted after the manifest is updated.
- Re-running with no chain advance is a no-op: the orchestrator derives each protocol's next-from-block from `max(hotHead.toBlock, lastSealed.toBlock)` and skips when there's nothing new.

## Cron entry (daily)

```
0 2 * * * cd /path/to/repo && node packages/producer/dist/orchestrator/cli.js \
  --config ./example-config.json \
  --rpc https://ethereum-rpc.publicnode.com \
  --output-dir ./chunks >> /var/log/orchestrator.log 2>&1
```

A single cron entry handles every protocol in the config. If a previous tick is still running when a new one fires, the new one exits quietly via the lockfile.

## Useful variations

**Restrict to one protocol** (backfilling or ad-hoc reruns):

```bash
node packages/producer/dist/orchestrator/cli.js \
  --config ./example-config.json \
  --rpc https://ethereum-rpc.publicnode.com \
  --output-dir ./chunks \
  --protocol-id tornado-cash-1-eth-0.1
```

The from-block is still derived from the manifest, so this catches that one protocol up to tip without affecting the others.

**Dry-run** (compute the per-protocol ranges, don't touch disk):

```bash
node packages/producer/dist/orchestrator/cli.js ... --dry-run
```

Prints what each protocol *would* scan; doesn't acquire the lockfile, so safe to run alongside a live cron.

**Batch size**: `--batch-size <n>` (default 100000) — blocks per atomic pipeline call. Smaller batches bound the crash blast radius (in-flight events lost on crash ≤ one batch); larger batches reduce hot-head rewrite overhead during cold-start backfills. For daily steady-state ticks one batch usually covers everything.

**Chunk size**: comes from `chunkSettings.maxSizeBytes` in the protocol's config entry (number or `0x`-hex), falling back to `--size-limit` (default 10 MiB). Set per-protocol when one contract's events are denser than another.

**Cold start a new protocol**: drop a new entry into the config (`chainId`, `fromBlock`, `events`). On the next tick the orchestrator finds no manifest entries for it and uses `config.fromBlock` as the starting block. No state files to bootstrap.

**Verify hot head integrity** (same shape as the sealed-chunk verification):

```bash
node --input-type=module -e "
import { blake3 } from '@noble/hashes/blake3.js';
import { gunzipSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
const idx = JSON.parse(readFileSync('./chunks/index.json', 'utf8'));
const hot = idx.availableProtocols?.['tornado-cash-1-eth-0.1']?.hotHead;
if (!hot) { console.log('no hot head'); process.exit(0); }
const data = gunzipSync(readFileSync('./chunks/' + hot.file));
const got = '0x' + Buffer.from(blake3(data)).toString('hex');
console.log(got === hot.digest.data ? 'OK' : 'MISMATCH', got);
"
```

**Full flag list:**

```bash
node packages/producer/dist/orchestrator/cli.js --help
```

## Exit codes

- `0` — clean run (zero or more protocols ran successfully, or another orchestrator was already running)
- `1` — config error, missing required flags, or unknown `--protocol-id`
- `2` — at least one protocol threw mid-run (others may still have succeeded; check stderr)
