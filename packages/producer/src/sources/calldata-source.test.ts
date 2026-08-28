import { describe, it, expect } from "vitest";
import { callOperations, decodeTransactions, hashBoundParams } from "./calldata-source.js";
import type { DecodedTransaction } from "./calldata-source.js";
import { NO_UTXO_OUTPUT } from "./railgun-operation.js";

const tx = (commitments: number, unshields = false, nullifiers = 1): DecodedTransaction => ({
  nullifiers: Array.from({ length: nullifiers }, (_, i) => BigInt(i + 1)),
  commitments: Array.from({ length: commitments }, (_, i) => BigInt(100 + i)),
  treeNumber: 3,
  unshields,
  boundParamsHash: 0xabcn,
});

const at = (r: unknown, field: string): bigint =>
  BigInt((r as Record<string, string>)[field]!);

describe("callOperations", () => {
  const event = { treeNumber: 3n, startPosition: 64776n };

  it("walks the running offset across a call's operations", () => {
    // The case measured on chain at block 25,840,662: 2 inserted, then two
    // operations that insert nothing and therefore do NOT advance the offset.
    const out = callOperations({
      transactions: [tx(2), tx(1, true), tx(1, true)],
      transactEvent: event,
      blockNumber: 1n,
      transactionIndex: 0n,
      context: "t",
    });
    expect(out.map((r) => at(r, "utxoBatchStartPositionOut"))).toEqual([64776n, 64778n, 64778n]);
    expect(out.map((r) => at(r, "utxoTreeOut"))).toEqual([3n, 3n, 3n]);
    expect(out.map((r) => at(r, "opIndex"))).toEqual([0n, 1n, 2n]);
  });

  it("excludes the unshield preimage from the inserted count", () => {
    // A transaction that unshields has its LAST commitment as a placeholder that
    // never enters the tree, so it advances the offset by one less.
    const out = callOperations({
      transactions: [tx(3, true), tx(1)],
      transactEvent: event,
      blockNumber: 1n,
      transactionIndex: 0n,
      context: "t",
    });
    expect(at(out[1]!, "utxoBatchStartPositionOut")).toBe(64776n + 2n);
  });

  it("uses the sentinel when the WHOLE call inserts nothing", () => {
    // Not per-operation: an op inserting 0 inside a call that inserts something
    // still reports the running offset (previous test). The sentinel is for a call
    // that emitted no batch event at all.
    const out = callOperations({
      transactions: [tx(1, true), tx(1, true)],
      blockNumber: 1n,
      transactionIndex: 0n,
      context: "t",
    });
    for (const r of out) {
      expect(at(r, "utxoTreeOut")).toBe(NO_UTXO_OUTPUT);
      expect(at(r, "utxoBatchStartPositionOut")).toBe(NO_UTXO_OUTPUT);
    }
  });

  it("throws when a call inserts commitments but has no batch event", () => {
    // Would silently mis-position every operation in the call.
    expect(() =>
      callOperations({
        transactions: [tx(2)],
        blockNumber: 1n,
        transactionIndex: 0n,
        context: "t",
      }),
    ).toThrow(/emitted no Transact event/);
  });

  it("carries the chain coordinate onto every record", () => {
    const out = callOperations({
      transactions: [tx(1), tx(1)],
      transactEvent: event,
      blockNumber: 0x189ad7bn,
      transactionIndex: 0x29n,
      context: "t",
    });
    expect(out.map((r) => at(r, "blockNumber"))).toEqual([0x189ad7bn, 0x189ad7bn]);
    expect(out.map((r) => at(r, "transactionIndex"))).toEqual([0x29n, 0x29n]);
  });
});

describe("decodeTransactions", () => {
  it("returns null for an unknown selector rather than throwing", () => {
    // Any contract may wrap transact(), so an unrecognised top-level selector is
    // expected — the caller falls back to tracing. Throwing here would halt the
    // run on ordinary traffic.
    expect(decodeTransactions("0xdeadbeef", "t")).toBeNull();
  });

  it("throws when a KNOWN selector carries undecodable calldata", () => {
    // Recognised but malformed is a real problem, unlike an unknown wrapper.
    expect(() => decodeTransactions("0xd8ae136a00", "t")).toThrow(/did not decode/);
  });
});

describe("hashBoundParams", () => {
  // The formula from contracts/logic/Verifier.sol, for both contract eras:
  //   uint256(keccak256(abi.encode(boundParams))) % SNARK_SCALAR_FIELD
  // The values themselves are verified end-to-end against the RAILGUN Squid over
  // the full history; these pin the two shapes apart so a change to one cannot
  // silently take the other with it.
  const v2 = {
    treeNumber: 3,
    minGasPrice: 0n,
    unshield: 0,
    chainID: 1n,
    adaptContract: "0x0000000000000000000000000000000000000000",
    adaptParams: `0x${"00".repeat(32)}`,
    commitmentCiphertext: [],
  };
  const v1 = {
    treeNumber: 3,
    withdraw: 0,
    adaptContract: "0x0000000000000000000000000000000000000000",
    adaptParams: `0x${"00".repeat(32)}`,
    commitmentCiphertext: [],
  };

  it("is deterministic", () => {
    expect(hashBoundParams(v2, "v2")).toBe(hashBoundParams(v2, "v2"));
  });

  it("reduces below the SNARK scalar field", () => {
    const FIELD =
      21888242871839275222246405745257275088548364400416034343698204186575808495617n;
    expect(hashBoundParams(v2, "v2")).toBeLessThan(FIELD);
    expect(hashBoundParams(v1, "v1")).toBeLessThan(FIELD);
  });

  it("gives different hashes for the two eras — the structs differ", () => {
    expect(hashBoundParams(v1, "v1")).not.toBe(hashBoundParams(v2, "v2"));
  });

  it("changes when any bound parameter changes", () => {
    expect(hashBoundParams({ ...v2, treeNumber: 4 }, "v2")).not.toBe(hashBoundParams(v2, "v2"));
  });
});
