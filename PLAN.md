# Plan: Event Scraper CLI

## Context

First module of the privacy-protocol-state-distribution pipeline. The scraper connects to an
Ethereum RPC, fetches logs matching per-protocol event filters, normalizes them, and emits them
as NDJSON to stdout. It is run periodically by a cron job and its output is piped to the chunk
builder (separate, later module). Progress between runs is tracked in a local `cursor.json`.

## What this review changed (vs. the first draft)

The first draft had a 1:1 "5 steps = 5 modules" mapping and pulled `chunkSettings` into the
scraper. On review:

1. **Steps != modules.** Steps 1 (connect), 2 (resolve range), 5 (emit) are one-liners — giving
   each its own file is ceremony. Real cohesive units are: config, cursor, scrape, normalize.
   The 5 steps stay *visible* as labeled sections in `cli.ts`. (This is the "up for discussion"
   point — see File layout.)
2. **Scraper ignores `chunkSettings` / `storeSettings` / `cronString`.** Those are the chunk
   builder's and orchestrator's concerns. The scraper reads only `events` and `fromBlock`.
   Config validation is lenient — only validate what we use.
3. **`eth_getLogs` must be windowed.** A cold cursor → head can be millions of blocks; one
   `getLogs` call would be rejected by every provider. `scrape.ts` is an async generator that
   slices the range into windows and **adaptively halves the window on range/result-size
   errors**. This is core correctness, not a nice-to-have.
4. **Streaming, not buffering.** A catch-up run can be huge. `scrape` yields logs window by
   window; the CLI normalizes + writes each line as it goes. Constant memory.
5. **Dropped `commander`.** One command, ~9 flags → Node's built-in `util.parseArgs`. Deps go
   from 3 to 2 (`viem`, `zod`).
6. **Canonical event = the full normalized log** (decided): indexed args — commitments,
   nullifiers — live in `topics[1..]`, not `data`. Dropping them would make the distributed
   state unable to rebuild the protocol tree. The README's chunk format has the same hole and
   is updated as part of this work (see README updates).
7. **Reorg safety — use the chain's own `finalized` block.** `toBlock` defaults to the live
   `finalized` block (queried each run), which is reorg-proof — no per-chain confirmations
   table needed, the chain reports its own finality. `--confirmations` (default 12) is only a
   fallback for chains/RPCs that don't support the `finalized` tag.
8. **Cold start is explicit.** First run has no cursor; the start block resolves as
   `--from-block` > cursor > config `fromBlock` (the deploy block) > hard error. Never defaults
   to genesis. `fromBlock` becomes a required config field (see README updates).

## Project setup

- **Node >= 20**, **TypeScript** (strict, ESM).
- **Runtime deps:** `viem`, `zod`.
- **Dev deps:** `typescript`, `@types/node`, `tsx`, `vitest`.
- `package.json` scripts: `build` → `tsc`, `start` → `node dist/cli.js`, `dev` → `tsx src/cli.ts`,
  `test` → `vitest`.
- `tsconfig.json`: `target ES2022`, `module/moduleResolution Node16`, `strict`, `outDir dist`.

## File layout

```
src/
  cli.ts         entry point: parseArgs + the 5-step pipeline, read top-to-bottom
  config.ts      load + lenient zod-validate config; exports Config, EventFilter, loadConfig()
  cursor.ts      atomic read/write of cursor.json; exports Cursor, readCursor(), writeCursor()
  scrape.ts      async generator: windowed eth_getLogs w/ adaptive split; exports scrape()
  normalize.ts   raw RPC log -> CanonicalEvent; exports CanonicalEvent, normalize()
```

5 files, each with a real reason to exist (testable seam, non-trivial logic). Types live with
their module — no separate `types.ts`. The user's "5 steps, each a module" idea is honored as
*labeled sections in `cli.ts`* rather than 5 files, because steps 1/2/5 are one-liners.

## The pipeline (`src/cli.ts`)

```ts
const args   = parseCliArgs();                                   // util.parseArgs
const config = loadConfig(args.config, args.protocolId);         // -> { events, fromBlock }
const cursor = readCursor(args.cursorPath);

// 1. Connect to the RPC
const client = createPublicClient({ transport: http(args.rpc) });

// 2. Resolve the block range to scan
const toBlock   = args.toBlock                                   // explicit override, else...
              ?? await finalizedBlock(client)                    // the chain's own finalized block
              ?? (await client.getBlockNumber()) - args.confirmations;  // fallback: tag unsupported
const fromBlock = args.fromBlock                                 // explicit override / backfill
              ?? nextAfter(cursor[args.protocolId])              // resume from cursor
              ?? config.fromBlock                                // cold start: deploy block from config
              ?? fail("cold start: set fromBlock in config or pass --from-block");

// 3. Fetch logs (windowed, streaming)  +  4. Normalize  +  5. Emit
for await (const log of scrape(client, { fromBlock, toBlock, events: config.events, window: args.window })) {
  process.stdout.write(JSON.stringify(normalize(log)) + "\n");   // steps 4 + 5
}

if (!args.dryRun) writeCursor(args.cursorPath, args.protocolId, toBlock);
process.stderr.write(`scraped ... [${fromBlock}, ${toBlock}]\n`); // summary on stderr, not stdout
```

`finalizedBlock(client)` is a small local helper in `cli.ts`: it calls viem's typed
`client.getBlock({ blockTag: "finalized" })` and returns `null` if the chain/RPC rejects the
tag (older RPCs, some L2s) — that `null` is what triggers the `--confirmations` fallback.

## Modules

### `config.ts`
- `loadConfig(path, protocolId): { events: EventFilter[]; fromBlock: Hex }` — read JSON,
  zod-validate **only** the fields the scraper uses: `protocols[protocolId].events` (array of
  `{contractAddress, eventTopic, filter?}`) and `protocols[protocolId].fromBlock` — a **new
  required field**, the contract deploy block (see README updates). Other fields
  (`chunkSettings`, `storeSettings`, `cronString`) pass through unvalidated — not the scraper's
  concern.

### `cursor.ts`
- `Cursor = Record<protocolId, { lastScrapedBlock: Hex }>`.
- `readCursor(path)` → `{}` if missing.
- `writeCursor(path, id, block)` → atomic (write `.tmp`, rename). Updated once per run, at the
  end. On crash the whole run re-does → at-least-once delivery; `(blockNumber, logIndex)` is the
  downstream dedup key.

### `scrape.ts`
- `async function* scrape(client, { fromBlock, toBlock, events, window })` — yields raw RPC logs.
- Slices `[fromBlock, toBlock]` into `window`-sized sub-ranges.
- Per sub-range, per `EventFilter`, calls **raw** `client.request({ method: "eth_getLogs",
  params: [{ address, topics: [eventTopic, ...filter], fromBlock, toBlock }] })`. Raw request
  (not viem's typed `getLogs`) because the config gives raw topic hashes, not an ABI — and logs
  come back already hex-stringy, which keeps `normalize` simple.
- On a "range too large" / "too many results" provider error: halve `window` and retry that
  sub-range. This is what makes it work against real RPCs.

### `normalize.ts`
- `normalize(log): CanonicalEvent` — lowercase all hex, pick fields, assert `topics[0]` exists.
- `CanonicalEvent = { contractAddress, eventTopic, topics[], data, blockNumber, logIndex,
  transactionHash, blockHash }` — the full normalized log. `eventTopic` = `topics[0]`, kept as
  an explicit field because the chunk builder groups by it; the full `topics` array is also
  kept so each event is self-describing. Nothing is dropped — lossy projection is the chunk
  builder's choice, not the scraper's.

## CLI flags (`scraper` — single command)

```
--config <path>        required   scraper config JSON
--protocol-id <id>      required   key in config.protocols to scrape
--rpc <url>            required   Ethereum RPC URL
--from-block <hex>     optional   override cursor / config fromBlock (e.g. for backfills)
--to-block <hex>       optional   override the resolved finalized/head block
--confirmations <n>    optional   fallback reorg buffer, default 12 — used only when the RPC
                                  does not support the `finalized` block tag
--window <n>           optional   blocks per eth_getLogs call, default 2000
--cursor-dir <path>    optional   dir for cursor.json, default = config file's dir
--dry-run              optional   do not persist the cursor update
```

## README updates (part of this work)

Two changes to `README.md`:

**1. "protocol state chunk" — keep `topics` and the tx/block hashes.** Each event object
becomes:

```json
{
    "topics": ["0x...", "0x..."],
    "data": "${gibberish}",
    "blockNumber": "0x1",
    "logIndex": "0x1",
    "transactionHash": "0x...",
    "blockHash": "0x..."
}
```

`contractAddress` and `eventTopic` stay as the grouping keys above each event list.

**2. "scrapper config" — add a required `fromBlock` per protocol instance.** The contract
deploy block; without it a cold-start run has no defined starting point. Sits alongside
`events`:

```json
"${protocol}-${chainId}-${protocolInstanceId}": {
    "fromBlock": "0x...",
    "cronString": "* * * * *",
    "chunkSettings": { ... },
    ...
}
```

## Flagged spec ambiguity (not blocking — heads-up)

The composite key `${protocol}-${chainId}-${protocolInstanceId}` is **not safely parseable**:
`protocol` names contain hyphens (`tornado-cash`, `privacy-pools`). `tornado-cash-1-mainnet` is
ambiguous. The scraper sidesteps this by treating the ID as an **opaque key** (config lookup +
cursor key only — it never needs `chainId`). But the broader spec (index files, chunk filenames)
should consider a non-hyphen delimiter or explicit `chainId`/`protocol` fields.

## Note on latency

Defaulting `toBlock` to the `finalized` block means the scraper trails the chain tip by
finality depth — ~13 min on Ethereum mainnet (vs. ~2.5 min for `head - 12`). For a batch cron
pipeline this is the right trade: the data is reorg-proof and no reorg-rewind logic is needed.
If a future use case needs lower latency, the natural extension is a `--block-tag safe|latest`
flag (`safe` ≈ ~6 min; `latest` applies `--confirmations`) — not built now.

## Verification

```bash
npm install && npm run build

# Cold start: no cursor + explicit range → emits, leaves cursor untouched (--dry-run)
rm -f cursor.json
node dist/cli.js \
  --config ./example-config.json --protocol-id <id> \
  --rpc https://eth.llamarpc.com \
  --from-block 0xC5A700 --to-block 0xC5A800 --dry-run | head -5
cat cursor.json            # still absent after --dry-run

# Cold start, no cursor, no --from-block, no config fromBlock → clear error, no output
# Cold start, no cursor, no --from-block, config has fromBlock → starts at config.fromBlock

# No --to-block → toBlock resolves to the chain's finalized block (check the stderr summary)
node dist/cli.js --config ... --protocol-id <id> --rpc https://eth.llamarpc.com --dry-run

# Real run advances the cursor to the resolved toBlock
node dist/cli.js --config ... --protocol-id <id> --rpc ... --from-block 0xC5A700 --to-block 0xC5A800
cat cursor.json            # lastScrapedBlock == 0xC5A800

# Large range exercises windowing + adaptive split
node dist/cli.js --config ... --rpc ... --from-block 0xC50000 --to-block 0xC5A800 --window 5000 --dry-run | wc -l
```

Unit tests (`vitest`): `normalize` (hex casing, missing topic), `scrape` (window slicing +
adaptive-split on a mocked `request`), `cursor` (atomic write, missing-file read), `config`
(required `fromBlock`, lenient validation of unused fields, bad `events`), `finalizedBlock`
(returns the block / returns `null` on an unsupported-tag error → triggers fallback).
