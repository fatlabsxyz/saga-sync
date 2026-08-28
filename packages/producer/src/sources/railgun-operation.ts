import type { CanonicalEntity, Hex } from "@saga-sync/core";

// The `railgun-operation` record — one per `Transaction` struct inside a
// `transact()` call, carrying what kohaku's TXID/POI indexer needs.
//
// This module owns the record's SHAPE: which fields, in which order, encoded how.
// It exists because two sources produce these records — one mirroring the RAILGUN
// Squid, one deriving them from calldata — and they must agree byte for byte, or
// the second cannot replace the first without rewriting published history. Keeping
// the shape in one place makes that identity structural rather than a thing to
// re-check.
//
// Field order IS the wire order: JSON.stringify preserves insertion order and the
// chunk digest is taken over those exact bytes. Do not reorder.

export const RAILGUN_OPERATION_ENTITY = "railgun-operation";

// The sentinel both position fields carry when a call inserts no commitments at
// all — every one of its transactions was an unshield, so the contract emitted no
// `Transact` event and there is no tree position to report. Not a tree index;
// consumers must not treat it as one. (kohaku passes it straight into
// `UtxoTreeIndex::included()`, so it enters the TXID leaf hash literally.)
export const NO_UTXO_OUTPUT = 99999n;

// Minimal 0x-hex, lowercase — the quantity encoding used everywhere in this format
// (SPEC §3.3).
export function quantity(value: string | number | bigint, field: string, ctx: string): Hex {
  let n: bigint;
  try {
    n = BigInt(value);
  } catch {
    throw new Error(`${ctx}: ${field} is not an integer: ${JSON.stringify(value)}`);
  }
  if (n < 0n) throw new Error(`${ctx}: ${field} is negative: ${value}`);
  return `0x${n.toString(16)}` as Hex;
}

// A full 32-byte word, zero-padded (SPEC §3.4). These are `bytes32` in the ABI, so
// their width is part of the type. Indexers commonly strip leading zero bytes; if
// we passed that through, the published bytes would depend on the upstream's
// formatting rather than on the value, and a calldata-derived source could never
// match a mirrored one.
export function bytes32(value: string | bigint, field: string, ctx: string): Hex {
  if (typeof value === "string" && !/^0x[0-9a-fA-F]*$/.test(value)) {
    throw new Error(`${ctx}: ${field} is not 0x-hex: ${JSON.stringify(value)}`);
  }
  let n: bigint;
  try {
    n = BigInt(value);
  } catch {
    throw new Error(`${ctx}: ${field} is not a number: ${JSON.stringify(value)}`);
  }
  if (n < 0n) throw new Error(`${ctx}: ${field} is negative: ${value}`);
  const hex = n.toString(16);
  if (hex.length > 64) {
    throw new Error(`${ctx}: ${field} exceeds 32 bytes: ${JSON.stringify(value)}`);
  }
  return `0x${hex.padStart(64, "0")}` as Hex;
}

// Everything a record needs, in whatever encoding the source has it. Values are
// normalized here so the two sources cannot drift.
export type RailgunOperationFields = {
  blockNumber: string | number | bigint;
  transactionIndex: string | number | bigint;
  opIndex: string | number | bigint;
  nullifiers: readonly (string | bigint)[];
  commitments: readonly (string | bigint)[];
  boundParamsHash: string | bigint;
  utxoTreeIn: string | number | bigint;
  utxoTreeOut: string | number | bigint;
  utxoBatchStartPositionOut: string | number | bigint;
};

export function railgunOperation(f: RailgunOperationFields, ctx: string): CanonicalEntity {
  return {
    entity: RAILGUN_OPERATION_ENTITY,
    blockNumber: quantity(f.blockNumber, "blockNumber", ctx),
    transactionIndex: quantity(f.transactionIndex, "transactionIndex", ctx),
    opIndex: quantity(f.opIndex, "opIndex", ctx),
    nullifiers: f.nullifiers.map((n, i) => bytes32(n, `nullifiers[${i}]`, ctx)),
    commitments: f.commitments.map((c, i) => bytes32(c, `commitments[${i}]`, ctx)),
    boundParamsHash: bytes32(f.boundParamsHash, "boundParamsHash", ctx),
    utxoTreeIn: quantity(f.utxoTreeIn, "utxoTreeIn", ctx),
    utxoTreeOut: quantity(f.utxoTreeOut, "utxoTreeOut", ctx),
    utxoBatchStartPositionOut: quantity(
      f.utxoBatchStartPositionOut,
      "utxoBatchStartPositionOut",
      ctx,
    ),
  };
}
