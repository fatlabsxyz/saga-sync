# Scraper CLI — usage

Quick reference for running the event scraper.

## One-time setup

```bash
npm install
npm run build
```

## Basic invocation

Run from the repo root, scrapes a small Tornado Cash range and emits the events as NDJSON on stdout:

```bash
node dist/cli.js \
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
node dist/cli.js --config ./example-config.json --protocol-id tornado-cash-1-eth-0.1 \
  --rpc https://ethereum-rpc.publicnode.com --from-block 0xC50000 --to-block 0xC50100
cat cursor.json   # → { "tornado-cash-1-eth-0.1": { "lastScrapedBlock": "0xc50100" } }
```

**Scrape up to the chain's finalized block** (omit `--to-block`):

```bash
node dist/cli.js --config ./example-config.json --protocol-id tornado-cash-1-eth-0.1 \
  --rpc https://ethereum-rpc.publicnode.com --from-block 0xC50101 --dry-run
```

**Pipe to `jq` to inspect:**

```bash
node dist/cli.js ... --dry-run | jq -c '{block: .blockNumber, topic: .eventTopic, tx: .transactionHash}'
```

**Full flag list:**

```bash
node dist/cli.js --help
```

## How cron would run it

Same command, scheduled (e.g. every 5 min). Output goes to stdout, summary to stderr, exit code 0 on success / 1 on error — so it's safe to pipe stdout into the chunk builder later:

```bash
*/5 * * * * cd /path/to/repo && node dist/cli.js --config ./example-config.json \
  --protocol-id tornado-cash-1-eth-0.1 --rpc https://ethereum-rpc.publicnode.com \
  | ./chunk-builder >> /var/log/state.log 2>&1
```
