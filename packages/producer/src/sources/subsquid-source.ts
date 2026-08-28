import type { CanonicalEntity, CanonicalRecord } from "@saga-sync/core";
import { railgunOperation, RAILGUN_OPERATION_ENTITY } from "./railgun-operation.js";
import type { ScraperSource } from "./types.js";

// Mirror a RAILGUN Squid GraphQL index.
//
// Only for data no log carries. The squid's `transaction` entity holds
// boundParamsHash and utxoTreeIn, which exist solely in transact() calldata, plus
// the per-transaction split of nullifiers/commitments that needs the same
// calldata to reconstruct. kohaku consumes it for TXID/POI.
//
// Transport deliberately mirrors kohaku's own subsquid.rs (keyset pagination on
// id_gt, terminate on an empty page, 3 retries at a fixed delay) so that when it
// misbehaves, both clients misbehave the same way and a bug reproduces on either.

const PAGE_LIMIT = 20_000;
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1_000;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// A squid `transaction.id` is three big-endian 32-byte words:
//   blockNumber ‖ transactionIndex ‖ opIndex
// It is a chain-native coordinate, not a database row id — which is why the
// records we publish can carry the same triple as first-class fields and a
// future calldata-derived source can emit byte-identical output.
const ID_WORD_HEX = 64;

export type SquidId = { blockNumber: bigint; transactionIndex: bigint; opIndex: bigint };

export function decodeSquidId(id: string): SquidId {
  const hex = id.startsWith("0x") ? id.slice(2) : id;
  if (hex.length !== ID_WORD_HEX * 3 || !/^[0-9a-fA-F]+$/.test(hex)) {
    throw new Error(
      `subsquid: expected a 96-byte hex id (blockNumber‖transactionIndex‖opIndex), got "${id}"`,
    );
  }
  const word = (i: number): bigint => BigInt(`0x${hex.slice(i * ID_WORD_HEX, (i + 1) * ID_WORD_HEX)}`);
  return { blockNumber: word(0), transactionIndex: word(1), opIndex: word(2) };
}

type RawOperation = {
  id: string;
  blockNumber: string;
  nullifiers: string[];
  commitments: string[];
  boundParamsHash: string;
  utxoTreeIn: string;
  utxoTreeOut: string;
  utxoBatchStartPositionOut: string;
};

// The query kohaku issues, field for field.
const OPERATIONS_QUERY = `query Operations($id_gt: String, $gte: BigInt, $lte: BigInt, $limit: Int) {
  transactions(
    orderBy: id_ASC
    where: {id_gt: $id_gt, blockNumber_gte: $gte, blockNumber_lte: $lte}
    limit: $limit
  ) {
    id
    blockNumber
    nullifiers
    commitments
    boundParamsHash
    utxoTreeIn
    utxoTreeOut
    utxoBatchStartPositionOut
  }
}`;

const HEIGHT_QUERY = `query Height { squidStatus { height } }`;

// Field order here IS the wire order — JSON.stringify preserves insertion order,
// and the chunk digest is taken over those exact bytes. Do not reorder.
export function toCanonicalOperation(raw: RawOperation, entity: string): CanonicalEntity {
  const id = decodeSquidId(raw.id);
  if (BigInt(raw.blockNumber) !== id.blockNumber) {
    // The id encodes the block; if the column disagrees, one of our assumptions
    // about this index is wrong and silently trusting either would be worse.
    throw new Error(
      `subsquid: id block ${id.blockNumber} disagrees with blockNumber ${raw.blockNumber}`,
    );
  }
  if (entity !== RAILGUN_OPERATION_ENTITY) {
    throw new Error(`subsquid: unsupported entity "${entity}"`);
  }
  // Shape and encoding come from railgun-operation.ts, shared with the
  // calldata source so the two are byte-identical by construction.
  return railgunOperation(
    {
      blockNumber: raw.blockNumber,
      transactionIndex: id.transactionIndex,
      opIndex: id.opIndex,
      nullifiers: raw.nullifiers,
      commitments: raw.commitments,
      boundParamsHash: raw.boundParamsHash,
      utxoTreeIn: raw.utxoTreeIn,
      utxoTreeOut: raw.utxoTreeOut,
      utxoBatchStartPositionOut: raw.utxoBatchStartPositionOut,
    },
    "subsquid",
  );
}

export type SubsquidSourceOptions = {
  endpoint: string;
  entity: string;
  // Ceiling from the chain itself. The squid indexes to within ~75 blocks of head,
  // i.e. AHEAD of finality, and our sealed chunks are immutable — so the tip is
  // clamped to this. Without it a reorg would rewrite history we already sealed.
  finalizedTip: bigint;
  fetchImpl?: typeof fetch;
  // Injectable so tests exercise the retry path without sleeping. Production
  // never sets it — the default matches kohaku's fixed 1s backoff.
  retryDelayMs?: number;
};

export class SubsquidSource implements ScraperSource {
  readonly kind = "subsquid";
  private readonly fetchImpl: typeof fetch;
  private readonly retryDelayMs: number;

  constructor(private readonly opts: SubsquidSourceOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.retryDelayMs = opts.retryDelayMs ?? RETRY_DELAY_MS;
  }

  private async query<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    let lastError = "";
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      if (attempt > 0) await sleep(this.retryDelayMs);
      let res: Response;
      try {
        res = await this.fetchImpl(this.opts.endpoint, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ query, variables }),
        });
      } catch (err) {
        lastError = (err as Error).message;
        continue;
      }
      if (!res.ok) {
        lastError = `HTTP ${res.status}`;
        continue;
      }
      let body: { data?: T; errors?: unknown[] };
      try {
        body = (await res.json()) as { data?: T; errors?: unknown[] };
      } catch (err) {
        lastError = `malformed JSON: ${(err as Error).message}`;
        continue;
      }
      // A GraphQL 200 can still carry errors; treating it as success would
      // silently publish a short page as if the range were empty.
      if (body.errors && body.errors.length > 0) {
        lastError = `GraphQL errors: ${JSON.stringify(body.errors)}`;
        continue;
      }
      if (!body.data) {
        lastError = "response had no data";
        continue;
      }
      return body.data;
    }
    throw new Error(
      `subsquid: ${this.opts.endpoint} failed after ${MAX_RETRIES} attempts — ${lastError}`,
    );
  }

  async *fetch(fromBlock: bigint, toBlock: bigint): AsyncGenerator<CanonicalRecord> {
    let cursor = "";
    for (;;) {
      const data = await this.query<{ transactions: RawOperation[] }>(OPERATIONS_QUERY, {
        id_gt: cursor,
        gte: fromBlock.toString(),
        lte: toBlock.toString(),
        limit: PAGE_LIMIT,
      });
      const page = data.transactions;
      for (const raw of page) yield toCanonicalOperation(raw, this.opts.entity);
      // Terminate on an empty page rather than a short one — same as kohaku, so a
      // paging bug in the index shows up identically in both.
      if (page.length === 0) return;
      cursor = page[page.length - 1]!.id;
    }
  }

  async latestCoveredBlock(): Promise<bigint> {
    const data = await this.query<{ squidStatus: { height: number | string } | null }>(
      HEIGHT_QUERY,
      {},
    );
    const height = data.squidStatus?.height;
    if (height === undefined || height === null) {
      throw new Error("subsquid: squidStatus.height missing — cannot establish a safe tip");
    }
    const indexed = BigInt(height);
    return indexed < this.opts.finalizedTip ? indexed : this.opts.finalizedTip;
  }
}
