# Scraper + Chunk Builder — usage

Quick reference for running the event scraper and the chunk builder pipeline.

## One-time setup

```bash
npm install
npm run build
```

## Basic invocation

Run from the repo root, scrapes a small Tornado Cash range and emits the events as NDJSON on stdout:

```bash
node dist/scraper/cli.js \
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
node dist/scraper/cli.js --config ./example-config.json --protocol-id tornado-cash-1-eth-0.1 \
  --rpc https://ethereum-rpc.publicnode.com --from-block 0xC50000 --to-block 0xC50100
cat cursor.json   # → { "tornado-cash-1-eth-0.1": { "lastScrapedBlock": "0xc50100" } }
```

**Scrape up to the chain's finalized block** (omit `--to-block`):

```bash
node dist/scraper/cli.js --config ./example-config.json --protocol-id tornado-cash-1-eth-0.1 \
  --rpc https://ethereum-rpc.publicnode.com --from-block 0xC50101 --dry-run
```

**Pipe to `jq` to inspect:**

```bash
node dist/scraper/cli.js ... --dry-run | jq -c '{block: .blockNumber, topic: .eventTopic, tx: .transactionHash}'
```

**Full flag list:**

```bash
node dist/scraper/cli.js --help
```

## How cron would run it

Same command, scheduled (e.g. every 5 min). Output goes to stdout, summary to stderr, exit code 0 on success / 1 on error — so it's safe to pipe stdout into the chunk builder:

```bash
*/5 * * * * cd /path/to/repo && node dist/scraper/cli.js --config ./example-config.json \
  --protocol-id tornado-cash-1-eth-0.1 --rpc https://ethereum-rpc.publicnode.com \
  | node dist/chunk-builder/cli.js --protocol-id tornado-cash-1-eth-0.1 \
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
node dist/scraper/cli.js --config ./example-config.json --protocol-id tornado-cash-1-eth-0.1 \
  --rpc https://ethereum-rpc.publicnode.com --from-block 0xC50101 --to-block 0xC50200 --dry-run \
| node dist/chunk-builder/cli.js \
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
  "availableStates": {
    "tornado-cash-1-eth-0.1": [
      {
        "fromBlock": "0xc50101",
        "toBlock": "0xc50201",
        "file": "tornado-cash-1-eth-0.1-[0xc50101,0xc50201).jsonl.gz",
        "size": "0x23e",
        "digest": {
          "type": "blake3",
          "data": "0xa757e92468fa95659cf0189440207540a5f9363b44d8d1b6a652af7acb49a48e"
        }
      }
    ]
  }
}
```

- `size`: compressed bytes (the actual file on disk).
- `digest.data`: blake3 of the **uncompressed** JSONL bytes — verify by `gunzip | blake3`.

## Useful variations

**Force multiple chunks** (set a small `--size-limit`):

```bash
node dist/scraper/cli.js ... | node dist/chunk-builder/cli.js \
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
const entry = idx.availableStates['tornado-cash-1-eth-0.1'][0];
const data = gunzipSync(readFileSync('./chunks/' + entry.file));
const got = '0x' + Buffer.from(blake3(data)).toString('hex');
console.log(got === entry.digest.data ? 'OK' : 'MISMATCH', got);
"
```

**Dry-run** (compute metadata, don't touch disk):

```bash
node dist/scraper/cli.js ... --dry-run | node dist/chunk-builder/cli.js \
  --protocol-id tornado-cash-1-eth-0.1 \
  --from-block 0xC50101 --to-block 0xC50201 \
  --output-dir ./chunks --dry-run
```

**Empty range** (no events): the chunk builder still emits one zero-byte chunk
covering the full `[from, to)`, so the manifest asserts the range was scanned.

**Full flag list:**

```bash
node dist/chunk-builder/cli.js --help
```
