import type { Hex, PublicClient, RpcLog } from "viem";
import { numberToHex } from "viem";
import type { EventFilter } from "./config.js";

export type ScrapeOptions = {
  fromBlock: bigint;
  toBlock: bigint;
  events: EventFilter[];
  window: number;
};

// Streams raw RPC logs for [fromBlock, toBlock]. The range is sliced into
// `window`-sized sub-ranges so a single eth_getLogs call never spans more blocks
// than a provider will accept. On a range/result-size error the window is halved
// and the same sub-range retried — that adaptive split is what makes this work
// against real RPCs whose limits vary.
// Sustained provider rate-limiting is retried with exponential backoff on top of
// viem's own transport retries; cap the attempts so a persistent outage still
// surfaces rather than hanging the run.
const MAX_RATE_LIMIT_RETRIES = 8;
const RATE_LIMIT_BASE_MS = 250;
const RATE_LIMIT_CAP_MS = 30_000;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// Exponential backoff with full jitter, capped.
function backoffMs(attempt: number): number {
  const exp = Math.min(RATE_LIMIT_CAP_MS, RATE_LIMIT_BASE_MS * 2 ** attempt);
  return Math.round(Math.random() * exp);
}

export async function* scrape(
  client: PublicClient,
  { fromBlock, toBlock, events, window }: ScrapeOptions,
): AsyncGenerator<RpcLog> {
  let windowSize = BigInt(Math.max(1, Math.floor(window)));
  let start = fromBlock;
  let rateLimitRetries = 0;

  while (start <= toBlock) {
    let end = start + windowSize - 1n;
    if (end > toBlock) end = toBlock;

    let logs: RpcLog[];
    try {
      logs = await getLogsForWindow(client, start, end, events);
    } catch (err) {
      if (isRangeError(err) && windowSize > 1n) {
        windowSize = windowSize / 2n;
        continue; // retry the same `start` with a smaller window
      }
      if (isRateLimitError(err) && rateLimitRetries < MAX_RATE_LIMIT_RETRIES) {
        await sleep(backoffMs(rateLimitRetries++));
        continue; // back off and retry the same window (don't shrink it)
      }
      throw err;
    }

    for (const log of logs) yield log;
    start = end + 1n;
    rateLimitRetries = 0; // a successful window resets the backoff counter
  }
}

async function getLogsForWindow(
  client: PublicClient,
  fromBlock: bigint,
  toBlock: bigint,
  events: EventFilter[],
): Promise<RpcLog[]> {
  // Fetch every event filter's logs for this window concurrently; with the
  // client's batch transport these coalesce into a single batched HTTP call.
  // If any filter hits a range error the whole window rejects and scrape()
  // halves it and retries — idempotent, so re-fetching the others is fine.
  const perFilter = await Promise.all(
    events.map((filter) => {
      const topics: Hex[] = [filter.eventTopic, ...(filter.filter ?? [])];
      return client.request({
        method: "eth_getLogs",
        params: [
          {
            address: filter.contractAddress,
            topics,
            fromBlock: numberToHex(fromBlock),
            toBlock: numberToHex(toBlock),
          },
        ],
      }) as Promise<RpcLog[]>;
    }),
  );
  const out = perFilter.flat();
  // Windows are scanned in ascending order; sorting within the window makes the
  // whole NDJSON stream globally ordered by (blockNumber, logIndex).
  out.sort((a, b) => {
    const ab = BigInt(a.blockNumber ?? 0);
    const bb = BigInt(b.blockNumber ?? 0);
    if (ab !== bb) return ab < bb ? -1 : 1;
    const ai = BigInt(a.logIndex ?? 0);
    const bi = BigInt(b.logIndex ?? 0);
    return ai < bi ? -1 : ai > bi ? 1 : 0;
  });
  return out;
}

function isRangeError(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return (
    msg.includes("range") ||
    msg.includes("too many results") ||
    msg.includes("too large") ||
    msg.includes("limit exceeded") ||
    msg.includes("more than") ||
    msg.includes("response size") ||
    msg.includes("query timeout")
  );
}

// Provider throttling (e.g. Alchemy "compute units per second capacity"). Kept
// disjoint from isRangeError's terms so a rate limit backs off rather than
// pointlessly shrinking the window. Checked after isRangeError.
function isRateLimitError(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return (
    msg.includes("429") ||
    msg.includes("rate limit") ||
    msg.includes("too many requests") ||
    msg.includes("capacity") ||
    msg.includes("compute unit") ||
    msg.includes("throughput")
  );
}
