import { describe, it, expect } from "vitest";
import { SubsquidSource, decodeSquidId, toCanonicalOperation } from "./subsquid-source.js";

const ENDPOINT = "https://squid.example/graphql";

// A squid id is blockNumber ‖ transactionIndex ‖ opIndex, three 32-byte words.
const squidId = (block: bigint, tx: bigint, op: bigint): string =>
  `0x${[block, tx, op].map((n) => n.toString(16).padStart(64, "0")).join("")}`;

const rawOp = (block: bigint, tx: bigint, op: bigint, over: Record<string, unknown> = {}) => ({
  id: squidId(block, tx, op),
  blockNumber: block.toString(), // squid returns BigInt as a DECIMAL string
  nullifiers: [`0x${"1".repeat(64)}`],
  commitments: [`0x${"2".repeat(64)}`],
  boundParamsHash: `0x${"3".repeat(64)}`,
  utxoTreeIn: "3",
  utxoTreeOut: "3",
  utxoBatchStartPositionOut: "63680",
  ...over,
});

// Stub transport: hands back queued responses in order, recording each request.
function stubFetch(responses: Array<{ status?: number; body: unknown } | Error>) {
  const calls: Array<{ query: string; variables: Record<string, unknown> }> = [];
  let i = 0;
  const impl = (async (_url: string, init: RequestInit) => {
    calls.push(JSON.parse(String(init.body)));
    const next = responses[Math.min(i++, responses.length - 1)]!;
    if (next instanceof Error) throw next;
    return {
      ok: (next.status ?? 200) >= 200 && (next.status ?? 200) < 300,
      status: next.status ?? 200,
      json: async () => next.body,
    } as Response;
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const collect = async (gen: AsyncGenerator<unknown>) => {
  const out: unknown[] = [];
  for await (const r of gen) out.push(r);
  return out;
};

describe("decodeSquidId", () => {
  it("splits the three words", () => {
    expect(decodeSquidId(squidId(25832120n, 300n, 1n))).toEqual({
      blockNumber: 25832120n,
      transactionIndex: 300n,
      opIndex: 1n,
    });
  });

  it("rejects an id that is not three 32-byte words", () => {
    expect(() => decodeSquidId("0xdeadbeef")).toThrow(/96-byte hex id/);
  });
});

describe("toCanonicalOperation", () => {
  it("normalizes decimal BigInts to minimal hex and keeps byte strings padded", () => {
    const rec = toCanonicalOperation(rawOp(25832120n, 300n, 1n) as never, "railgun-operation");
    expect(rec).toEqual({
      entity: "railgun-operation",
      blockNumber: "0x18a2ab8",
      transactionIndex: "0x12c",
      opIndex: "0x1",
      nullifiers: [`0x${"1".repeat(64)}`],
      commitments: [`0x${"2".repeat(64)}`],
      boundParamsHash: `0x${"3".repeat(64)}`,
      utxoTreeIn: "0x3",
      utxoTreeOut: "0x3",
      utxoBatchStartPositionOut: "0xf8c0",
    });
  });

  it("serializes with a FIXED field order — the chunk digest is over these bytes", () => {
    const rec = toCanonicalOperation(rawOp(1n, 2n, 3n) as never, "railgun-operation");
    expect(Object.keys(rec)).toEqual([
      "entity",
      "blockNumber",
      "transactionIndex",
      "opIndex",
      "nullifiers",
      "commitments",
      "boundParamsHash",
      "utxoTreeIn",
      "utxoTreeOut",
      "utxoBatchStartPositionOut",
    ]);
  });

  it("emits zero as 0x0, not 0x or 0x00", () => {
    const rec = toCanonicalOperation(rawOp(1n, 0n, 0n, { utxoTreeIn: "0" }) as never, "e");
    expect(rec.opIndex).toBe("0x0");
    expect(rec.transactionIndex).toBe("0x0");
    expect(rec.utxoTreeIn).toBe("0x0");
  });

  it("PADS bytes32 fields the squid returned with leading zeros stripped", () => {
    // The squid emits minimal-width hex for bytes32. Passing that through would
    // make our bytes depend on its formatting, so a calldata-derived source could
    // never match them.
    const short = rawOp(1n, 0n, 0n, {
      nullifiers: ["0x320f842b8835f5983636b535fb4af0701a8a1cfb225fa269eb6f8f5f8fb381"], // 31 bytes
      commitments: ["0x1"],
      boundParamsHash: "0x0abc",
    });
    const rec = toCanonicalOperation(short as never, "e");
    expect(rec.nullifiers).toEqual([
      "0x00320f842b8835f5983636b535fb4af0701a8a1cfb225fa269eb6f8f5f8fb381",
    ]);
    expect(rec.commitments).toEqual([`0x${"0".repeat(63)}1`]);
    expect(rec.boundParamsHash).toBe(`0x${"0".repeat(60)}0abc`);
    for (const v of [...(rec.nullifiers as string[]), ...(rec.commitments as string[]), rec.boundParamsHash as string])
      expect(v).toHaveLength(66);
  });

  it("leaves an already-padded 32-byte value untouched", () => {
    const full = `0x${"ab".repeat(32)}`;
    const rec = toCanonicalOperation(rawOp(1n, 0n, 0n, { boundParamsHash: full }) as never, "e");
    expect(rec.boundParamsHash).toBe(full);
  });

  it("refuses a bytes32 field wider than 32 bytes rather than truncating", () => {
    const bad = rawOp(1n, 0n, 0n, { boundParamsHash: `0x${"ff".repeat(33)}` });
    expect(() => toCanonicalOperation(bad as never, "e")).toThrow(/exceeds 32 bytes/);
  });

  it("refuses a row whose id block disagrees with its blockNumber column", () => {
    const bad = rawOp(10n, 0n, 0n, { blockNumber: "11" });
    expect(() => toCanonicalOperation(bad as never, "e")).toThrow(/disagrees/);
  });

  it("refuses a non-integer quantity rather than coercing it", () => {
    const bad = rawOp(1n, 0n, 0n, { utxoTreeOut: "not-a-number" });
    expect(() => toCanonicalOperation(bad as never, "e")).toThrow(/not an integer/);
  });
});

describe("SubsquidSource.fetch", () => {
  it("pages by id_gt and stops on an EMPTY page, not a short one", async () => {
    const page1 = [rawOp(1n, 0n, 0n), rawOp(2n, 0n, 0n)];
    const { impl, calls } = stubFetch([
      { body: { data: { transactions: page1 } } },
      { body: { data: { transactions: [] } } },
    ]);
    const src = new SubsquidSource({
      endpoint: ENDPOINT, entity: "railgun-operation", finalizedTip: 100n, fetchImpl: impl, retryDelayMs: 0,
    });
    const got = await collect(src.fetch(0n, 50n));
    expect(got).toHaveLength(2);
    // A short page did NOT end the loop; the empty one did.
    expect(calls).toHaveLength(2);
    expect(calls[0]!.variables.id_gt).toBe("");
    expect(calls[1]!.variables.id_gt).toBe(page1[1]!.id);
  });

  it("passes the block range through as inclusive bounds", async () => {
    const { impl, calls } = stubFetch([{ body: { data: { transactions: [] } } }]);
    const src = new SubsquidSource({
      endpoint: ENDPOINT, entity: "e", finalizedTip: 100n, fetchImpl: impl, retryDelayMs: 0,
    });
    await collect(src.fetch(7n, 9n));
    expect(calls[0]!.variables).toMatchObject({ gte: "7", lte: "9", limit: 20000 });
  });

  it("retries a transport failure, then succeeds", async () => {
    const { impl, calls } = stubFetch([
      new Error("connection reset"),
      { body: { data: { transactions: [] } } },
    ]);
    const src = new SubsquidSource({
      endpoint: ENDPOINT, entity: "e", finalizedTip: 100n, fetchImpl: impl, retryDelayMs: 0,
    });
    await expect(collect(src.fetch(0n, 1n))).resolves.toEqual([]);
    expect(calls.length).toBeGreaterThanOrEqual(2);
  });

  it("gives up after 3 attempts and names the endpoint", async () => {
    const { impl } = stubFetch([{ status: 502, body: {} }]);
    const src = new SubsquidSource({
      endpoint: ENDPOINT, entity: "e", finalizedTip: 100n, fetchImpl: impl, retryDelayMs: 0,
    });
    await expect(collect(src.fetch(0n, 1n))).rejects.toThrow(/failed after 3 attempts/);
  });

  it("treats a 200 carrying GraphQL errors as a failure, not an empty range", async () => {
    // The dangerous case: succeeding here would publish "no operations in this
    // range" and seal it as truth.
    const { impl } = stubFetch([{ body: { errors: [{ message: "boom" }] } }]);
    const src = new SubsquidSource({
      endpoint: ENDPOINT, entity: "e", finalizedTip: 100n, fetchImpl: impl, retryDelayMs: 0,
    });
    await expect(collect(src.fetch(0n, 1n))).rejects.toThrow(/GraphQL errors/);
  });
});

describe("SubsquidSource.latestCoveredBlock", () => {
  const withHeight = (height: number | string, finalizedTip: bigint) => {
    const { impl } = stubFetch([{ body: { data: { squidStatus: { height } } } }]);
    return new SubsquidSource({ endpoint: ENDPOINT, entity: "e", finalizedTip, fetchImpl: impl, retryDelayMs: 0 });
  };

  it("CLAMPS to the finalized tip when the index runs ahead of finality", async () => {
    // The whole point: the squid indexes to within ~75 blocks of head, which is
    // past finality. Sealing that far would make immutable chunks reorg-able.
    expect(await withHeight(25_832_274, 25_832_200n).latestCoveredBlock()).toBe(25_832_200n);
  });

  it("uses the index height when it lags finality", async () => {
    expect(await withHeight(1_000, 25_832_200n).latestCoveredBlock()).toBe(1_000n);
  });

  it("throws rather than guessing when the index reports no height", async () => {
    const { impl } = stubFetch([{ body: { data: { squidStatus: null } } }]);
    const src = new SubsquidSource({
      endpoint: ENDPOINT, entity: "e", finalizedTip: 10n, fetchImpl: impl, retryDelayMs: 0,
    });
    await expect(src.latestCoveredBlock()).rejects.toThrow(/cannot establish a safe tip/);
  });
});
