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
export async function* scrape(
  client: PublicClient,
  { fromBlock, toBlock, events, window }: ScrapeOptions,
): AsyncGenerator<RpcLog> {
  let windowSize = BigInt(Math.max(1, Math.floor(window)));
  let start = fromBlock;

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
      throw err;
    }

    for (const log of logs) yield log;
    start = end + 1n;
  }
}

async function getLogsForWindow(
  client: PublicClient,
  fromBlock: bigint,
  toBlock: bigint,
  events: EventFilter[],
): Promise<RpcLog[]> {
  const out: RpcLog[] = [];
  for (const filter of events) {
    const topics: Hex[] = [filter.eventTopic, ...(filter.filter ?? [])];
    const logs = (await client.request({
      method: "eth_getLogs",
      params: [
        {
          address: filter.contractAddress,
          topics,
          fromBlock: numberToHex(fromBlock),
          toBlock: numberToHex(toBlock),
        },
      ],
    })) as RpcLog[];
    out.push(...logs);
  }
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
