import type { Hex, PublicClient, RpcLog, RpcTransaction } from "viem";
import { decodeFunctionData, encodeAbiParameters, keccak256, numberToHex } from "viem";
import type { CanonicalRecord } from "@saga-sync/core";
import type { ScraperSource } from "./types.js";
import { scrape } from "../scraper/scrape.js";
import {
  KNOWN_SELECTORS,
  SNARK_SCALAR_FIELD,
  TRANSACT_ABI,
  TRANSACT_ABI_V1,
  UNSHIELD_NONE,
  boundParamsAbi,
  boundParamsAbiV1,
} from "./railgun-abi.js";
import { NO_UTXO_OUTPUT, railgunOperation } from "./railgun-operation.js";

// Derive Railgun's per-transaction operations from `transact()` calldata.
//
// The same records the RAILGUN Squid serves, but from the chain — which is the
// point. A mirror cannot outlive its upstream; this can, and its bytes are
// reproducible from chain data alone, which is the guarantee SPEC §10 makes for
// everything else we publish.
//
// The fields exist nowhere else: `boundParamsHash` and the input tree number are
// arguments to `transact()`, and the split of nullifiers and commitments across
// the transactions in one call is only visible in the calldata. No log carries
// any of it.

// The `Transact` event: (uint256 treeNumber, uint256 startPosition, bytes32[] hash,
// CommitmentCiphertext[] ciphertext). We need the first two words, which are
// static and therefore at fixed offsets in `data`.
const TRANSACT_TOPIC = "0x56a618cda1e34057b7f849a5792f6c8587a2dbe11c83d0254e72cb3daffda7d1";
// V1's equivalent: CommitmentBatch(uint256 treeNumber, uint256 startPosition, ...).
// Its first two words sit at the same offsets, so one reader serves both.
const COMMITMENT_BATCH_TOPIC =
  "0xc82d23263b236b692a8094d858e0831328f26cd9bcd5127d91c9299036cb9de9";
// V1 shields: GeneratedCommitmentBatch(uint256 treeNumber, uint256 startPosition, ...).
// Tracked ONLY to reproduce an upstream quirk — see pickBatchEvent.
const GENERATED_COMMITMENT_BATCH_TOPIC =
  "0xf75eaa09da191ca634619d229eaa2a62f3f30b79ef6e9a0a2cb33ae1dc07d71c";

// Which events can supply a batch's (treeNumber, startPosition). All three put
// those in their first two data words, so one reader serves them.
const BATCH_TOPICS = new Set([
  TRANSACT_TOPIC,
  COMMITMENT_BATCH_TOPIC,
  GENERATED_COMMITMENT_BATCH_TOPIC,
]);

// Nullified(uint16 treeNumber, bytes32[] nullifier) — emitted once per Transaction
// struct. Its presence is what marks a call as operation-producing: an operation
// spends notes. A pure shield() emits only Shield and yields no operations, so
// keying on "any Railgun log" would drag those in and then fail to decode them.
const NULLIFIED_TOPIC = "0x781745c57906dc2f175fec80a9c691744c91c48a34a83672c41c2604774eb11f";
// V1's equivalent: Nullifiers(uint256 treeNumber, uint256[] nullifier).
const NULLIFIERS_V1_TOPIC =
  "0x78b6af109cf8ed292e957cdc2975e50bfd37995f5c38d35dc10e2ed0007cbd09";

function word(data: string, index: number): bigint {
  const start = 2 + index * 64;
  const hex = data.slice(start, start + 64);
  if (hex.length !== 64) throw new Error(`Transact event data too short for word ${index}`);
  return BigInt(`0x${hex}`);
}

// `hashBoundParams` from contracts/logic/Verifier.sol:
//   uint256(keccak256(abi.encode(_boundParams))) % SNARK_SCALAR_FIELD
// `abi.encode` of a single dynamic struct is exactly what encodeAbiParameters
// produces for a one-element tuple parameter list — verified against live chain
// data before this was written.
export function hashBoundParams(boundParams: unknown, era: "v1" | "v2" = "v2"): bigint {
  const shape = era === "v1" ? boundParamsAbiV1 : boundParamsAbi;
  const encoded = encodeAbiParameters([shape], [boundParams as never]);
  return BigInt(keccak256(encoded)) % SNARK_SCALAR_FIELD;
}

// What the rest of the pipeline works with. The two contract eras differ in
// struct shape, field names and ABI types; all of that is resolved here so the
// position arithmetic below never has to ask which era it is looking at.
export type DecodedTransaction = {
  nullifiers: readonly (Hex | bigint)[];
  commitments: readonly (Hex | bigint)[];
  treeNumber: number;
  // Whether the LAST commitment is an unshield preimage rather than a real leaf.
  unshields: boolean;
  boundParamsHash: bigint;
};

// How many of a transaction's commitments actually enter the UTXO tree. When the
// transaction unshields, its LAST commitment is the unshield preimage — a
// placeholder that is never inserted.
function insertedCount(t: DecodedTransaction): number {
  return t.commitments.length - (t.unshields ? 1 : 0);
}

export type CallOperationsInput = {
  transactions: readonly DecodedTransaction[];
  // (treeNumber, startPosition) from this call's Transact event, or undefined when
  // the call emitted none.
  transactEvent?: { treeNumber: bigint; startPosition: bigint };
  blockNumber: bigint;
  transactionIndex: bigint;
  context: string;
};

// Turn one `transact()`/`relay()` call into its operation records.
//
// The position rule, established against live data:
//   - A call that inserts NOTHING (every transaction was an unshield) emits no
//     Transact event, so there is no tree position. Both fields get the 99999
//     sentinel.
//   - Otherwise every transaction reports the call's tree and the running offset
//     within the batch. A transaction that inserts nothing still reports the
//     CURRENT offset — it just does not advance it. (Getting this wrong is easy:
//     an op with zero insertions is not the same as a call with zero insertions.)
export function callOperations(input: CallOperationsInput): CanonicalRecord[] {
  const total = input.transactions.reduce((n, t) => n + insertedCount(t), 0);
  const sentinel = total === 0;
  if (!sentinel && !input.transactEvent) {
    throw new Error(
      `${input.context}: call inserts ${total} commitment(s) but emitted no Transact event`,
    );
  }

  const out: CanonicalRecord[] = [];
  let offset = 0n;
  for (const [opIndex, t] of input.transactions.entries()) {
    out.push(
      railgunOperation(
        {
          blockNumber: input.blockNumber,
          transactionIndex: input.transactionIndex,
          opIndex,
          nullifiers: t.nullifiers,
          commitments: t.commitments,
          boundParamsHash: t.boundParamsHash,
          utxoTreeIn: t.treeNumber,
          utxoTreeOut: sentinel ? NO_UTXO_OUTPUT : input.transactEvent!.treeNumber,
          utxoBatchStartPositionOut: sentinel
            ? NO_UTXO_OUTPUT
            : input.transactEvent!.startPosition + offset,
        },
        input.context,
      ),
    );
    offset += BigInt(insertedCount(t));
  }
  return out;
}

// Pull the Transaction[] out of a call, or null when the selector is not one we
// know how to read.
//
// Null rather than throw because an unknown top-level selector is EXPECTED: any
// contract may wrap RailgunSmartWallet.transact(), and third-party broadcasters do.
// Their calldata layout is their own, so the array is only reachable by tracing the
// internal call (see traceForTransactions). Throwing is left for the case where
// even that fails.
export function decodeTransactions(
  input: Hex,
  context: string,
): readonly DecodedTransaction[] | null {
  const selector = input.slice(0, 10).toLowerCase();
  const entry = KNOWN_SELECTORS[selector];
  if (!entry) return null;
  let raw: readonly Record<string, never>[];
  try {
    const { args } = decodeFunctionData({
      abi: entry.era === "v1" ? TRANSACT_ABI_V1 : TRANSACT_ABI,
      data: input,
    });
    // Every entry point carries Transaction[] as argument 0 — `relay` just adds
    // a tail after it.
    raw = args[0] as unknown as readonly Record<string, never>[];
  } catch (err) {
    throw new Error(`${context}: selector ${selector} did not decode: ${(err as Error).message}`);
  }
  return raw.map((t) => {
    const bp = t.boundParams as unknown as {
      treeNumber: number;
      unshield?: number;
      withdraw?: number;
    };
    // V2 calls the flag `unshield`, V1 calls it `withdraw`; both are the same enum
    // where 0 means "no unshield".
    const flag = entry.era === "v1" ? bp.withdraw : bp.unshield;
    return {
      nullifiers: t.nullifiers as unknown as readonly (Hex | bigint)[],
      commitments: t.commitments as unknown as readonly (Hex | bigint)[],
      treeNumber: bp.treeNumber,
      unshields: flag !== UNSHIELD_NONE,
      boundParamsHash: hashBoundParams(t.boundParams, entry.era),
    };
  });
}

type TraceCall = { to?: string; input?: string; calls?: TraceCall[] };

// Find the inner call to RailgunSmartWallet and decode THAT. Handles arbitrary
// wrappers — the top-level calldata can be anything, but the call that actually
// reaches the contract must carry a Transaction[] in a shape we know.
async function traceForTransactions(
  client: PublicClient,
  hash: Hex,
  address: Hex,
  context: string,
): Promise<readonly DecodedTransaction[]> {
  let trace: TraceCall;
  try {
    trace = (await client.request({
      method: "debug_traceTransaction",
      params: [hash, { tracer: "callTracer" }],
    } as never)) as TraceCall;
  } catch (err) {
    throw new Error(
      `${context}: top-level selector is unknown and debug_traceTransaction is ` +
        `unavailable on this RPC (${(err as Error).message}). A tracing-capable ` +
        `endpoint is required — arbitrary contracts may wrap transact().`,
    );
  }

  const target = address.toLowerCase();
  const hits: (readonly DecodedTransaction[])[] = [];
  const walk = (call: TraceCall): void => {
    if (call.to?.toLowerCase() === target && call.input) {
      const decoded = decodeTransactions(call.input as Hex, context);
      if (decoded) hits.push(decoded);
    }
    for (const sub of call.calls ?? []) walk(sub);
  };
  walk(trace);

  if (hits.length === 0) {
    throw new Error(
      `${context}: no recognisable transact()/relay() call to ${address} in the trace`,
    );
  }
  if (hits.length > 1) {
    throw new Error(
      `${context}: ${hits.length} transact() calls in one transaction — batch layout unknown`,
    );
  }
  return hits[0]!;
}

export type CalldataSourceOptions = {
  client: PublicClient;
  // The RailgunSmartWallet address whose logs identify the calls to decode.
  address: Hex;
  window: number;
  finalizedTip: bigint;
};

export class CalldataSource implements ScraperSource {
  readonly kind = "calldata";

  constructor(private readonly opts: CalldataSourceOptions) {}

  async *fetch(fromBlock: bigint, toBlock: bigint): AsyncGenerator<CanonicalRecord> {
    // 1. Every Railgun log in the range — not just Transact. An all-unshield call
    //    emits only Nullified/Unshield yet still produces operations (the sentinel
    //    case), so filtering to Transact here would silently drop them.
    //
    //    Raw logs rather than our published stream: CanonicalEvent drops
    //    transactionHash, so the stream cannot attribute an event to its call.
    const byTx = new Map<
      Hex,
      { index: bigint; block: bigint; transact?: RpcLog; spends: boolean }
    >();
    for await (const log of scrape(this.opts.client, {
      fromBlock,
      toBlock,
      events: [{ contractAddress: this.opts.address }],
      window: this.opts.window,
    })) {
      const hash = log.transactionHash as Hex | null;
      if (!hash || log.blockNumber == null || log.transactionIndex == null) continue;
      let entry = byTx.get(hash);
      if (!entry) {
        entry = {
          index: BigInt(log.transactionIndex),
          block: BigInt(log.blockNumber),
          spends: false,
        };
        byTx.set(hash, entry);
      }
      const topic0 = log.topics[0]?.toLowerCase();
      if (topic0 === NULLIFIED_TOPIC || topic0 === NULLIFIERS_V1_TOPIC) entry.spends = true;
      if (topic0 && BATCH_TOPICS.has(topic0)) {
        // LAST batch event in the transaction wins, deliberately.
        //
        // This reproduces a quirk in the RAILGUN Squid rather than the chain's own
        // truth. A V1 call that both transacts and shields emits CommitmentBatch
        // (carrying THIS operation's leaves) and then GeneratedCommitmentBatch
        // (the shield's); the squid reports the latter's position for the
        // operation, which double-counts. Verified at blocks 14,916,595
        // (197 vs 200) and 14,957,311 (270 vs 272) — our reading reconciles with
        // the leaf counts, the squid's does not.
        //
        // We match it on purpose: kohaku validates TXID roots against the POI
        // node, which is built from squid-shaped data, so a "correct" stream
        // would make POI proofs fail to validate for these transactions. Affects
        // ~8 in 205 V1-era operations and nothing in V2, where the shield event is
        // not part of this family. See docs/RAILGUN.md §5.3.
        entry.transact = log;
      }
    }
    // Keep only the calls that actually spend. Shields reach the same contract and
    // emit their own events, but carry no Transaction[] at all.
    for (const [hash, entry] of byTx) if (!entry.spends) byTx.delete(hash);
    if (byTx.size === 0) return;

    // 2. Fetch each call's input. viem's batch transport coalesces these.
    const hashes = [...byTx.keys()];
    const txs = await Promise.all(
      hashes.map((hash) =>
        this.opts.client.request({
          method: "eth_getTransactionByHash",
          params: [hash],
        }) as Promise<RpcTransaction | null>,
      ),
    );

    // 3. Decode and emit, in chain order.
    const rows: { key: [bigint, bigint]; records: CanonicalRecord[] }[] = [];
    for (const [i, hash] of hashes.entries()) {
      const entry = byTx.get(hash)!;
      const tx = txs[i];
      if (!tx) throw new Error(`${hash}: transaction not found while decoding calldata`);
      const context = `railgun-ops ${hash}`;
      const transactions =
        decodeTransactions(tx.input as Hex, context) ??
        (await traceForTransactions(this.opts.client, hash, this.opts.address, context));
      const transactEvent = entry.transact
        ? {
            treeNumber: word(entry.transact.data, 0),
            startPosition: word(entry.transact.data, 1),
          }
        : undefined;
      rows.push({
        key: [entry.block, entry.index],
        records: callOperations({
          transactions,
          ...(transactEvent ? { transactEvent } : {}),
          blockNumber: entry.block,
          transactionIndex: entry.index,
          context,
        }),
      });
    }
    rows.sort((a, b) =>
      a.key[0] === b.key[0]
        ? a.key[1] < b.key[1]
          ? -1
          : a.key[1] > b.key[1]
            ? 1
            : 0
        : a.key[0] < b.key[0]
          ? -1
          : 1,
    );
    for (const row of rows) for (const record of row.records) yield record;
  }

  latestCoveredBlock(): Promise<bigint> {
    // No index to lag behind — the chain's finalized tip is the whole story.
    return Promise.resolve(this.opts.finalizedTip);
  }
}

// Re-exported for the tests' benefit; `numberToHex` keeps the import used.
export { numberToHex };
