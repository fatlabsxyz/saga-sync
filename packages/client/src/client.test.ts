import { describe, it, expect, beforeEach } from "vitest";
import { gzipSync } from "node:zlib";
import type { CanonicalEvent } from "@saga-sync/core";
import type { Store } from "@saga-sync/core";
import { ChunkArchive } from "@saga-sync/producer";
import { Manifest } from "@saga-sync/core";
import { Client } from "./client.js";
import { DigestMismatchError } from "./verify.js";
import { generateKeyPair, signManifest, ManifestSignatureError } from "@saga-sync/core";

// Instrumented in-memory store: records gets/puts and tracks peak concurrent
// in-flight gets. `getDelayMs` holds gets open so overlap is observable.
class MemStore implements Store {
  readonly data = new Map<string, Buffer>();
  getCalls: string[] = [];
  putCalls: string[] = [];
  private inFlight = 0;
  maxInFlight = 0;
  constructor(private readonly getDelayMs = 0) {}
  async get(key: string): Promise<Buffer | null> {
    this.getCalls.push(key);
    this.inFlight++;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    try {
      if (this.getDelayMs > 0) await new Promise((r) => setTimeout(r, this.getDelayMs));
      return this.data.get(key) ?? null;
    } finally {
      this.inFlight--;
    }
  }
  async put(key: string, data: Buffer): Promise<void> {
    this.putCalls.push(key);
    this.data.set(key, Buffer.from(data));
  }
  async delete(key: string): Promise<void> {
    this.data.delete(key);
  }
  async list(prefix: string): Promise<string[]> {
    return [...this.data.keys()].filter((k) => k.startsWith(prefix));
  }
}

const event = (block: bigint, logIndex = 0): CanonicalEvent => ({
  contractAddress: "0x12d66f87a04a9e220743712ce6d9bb1b5616b8fc",
  eventTopic: "0xa945e51eec50ab98c161376f0db4cf2aeba3ec92755fe2fcd388bdbbb80ff196",
  topics: ["0xa945e51eec50ab98c161376f0db4cf2aeba3ec92755fe2fcd388bdbbb80ff196"],
  data: "0x",
  blockNumber: `0x${block.toString(16)}`,
  logIndex: `0x${logIndex.toString(16)}`,
});

const PID = "tornado-cash-1-eth-0.1";

// Publish N sealed chunks + an optional hot head into a store, returning the
// flat ordered event list for comparison.
async function publish(
  store: Store,
  sealedRanges: { from: bigint; to: bigint; events: CanonicalEvent[] }[],
  hot?: { from: bigint; to: bigint; events: CanonicalEvent[] },
  signer?: (bytes: Uint8Array) => `0x${string}`,
): Promise<CanonicalEvent[]> {
  const archive = new ChunkArchive(store);
  const manifest = await Manifest.load(store, undefined, { signer });
  const all: CanonicalEvent[] = [];
  for (const r of sealedRanges) {
    const meta = await archive.seal(PID, r.events, { from: r.from, to: r.to });
    await manifest.appendChunk(PID, meta);
    all.push(...r.events);
  }
  if (hot) {
    const meta = await archive.writeHotHead(PID, hot.events, { from: hot.from, to: hot.to });
    await manifest.setHotHead(PID, meta);
    all.push(...hot.events);
  }
  return all;
}

async function collect(it: AsyncIterable<CanonicalEvent>): Promise<CanonicalEvent[]> {
  const out: CanonicalEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

describe("Client", () => {
  let source: MemStore;
  beforeEach(() => {
    source = new MemStore();
  });

  it("fetchManifest parses the published manifest", async () => {
    await publish(source, [{ from: 1n, to: 2n, events: [event(1n)] }]);
    const client = new Client({ source });
    const manifest = await client.fetchManifest();
    expect(manifest.sealedChunks(PID)).toHaveLength(1);
  });

  it("streamEvents yields all events in block order across chunks + hot head", async () => {
    const expected = await publish(
      source,
      [
        { from: 1n, to: 3n, events: [event(1n), event(2n)] },
        { from: 3n, to: 5n, events: [event(3n), event(4n)] },
      ],
      { from: 5n, to: 7n, events: [event(5n), event(6n)] },
    );
    const client = new Client({ source });
    expect(await collect(client.streamEvents(PID))).toEqual(expected);
  });

  it("works with sealed chunks only (no hot head)", async () => {
    const expected = await publish(source, [{ from: 1n, to: 2n, events: [event(1n)] }]);
    const client = new Client({ source });
    expect(await collect(client.streamEvents(PID))).toEqual(expected);
  });

  it("block-range filter skips out-of-window sealed chunks without fetching them", async () => {
    await publish(source, [
      { from: 0n, to: 10n, events: [event(5n)] },
      { from: 10n, to: 20n, events: [event(15n)] },
      { from: 20n, to: 30n, events: [event(25n)] },
    ]);
    const client = new Client({ source });
    source.getCalls = [];
    const got = await collect(client.streamEvents(PID, { fromBlock: 10n, toBlock: 20n }));
    expect(got.map((e) => e.blockNumber)).toEqual(["0xf"]);
    // index.json + the one in-window chunk only; the two out-of-window chunks
    // were never fetched.
    const chunkGets = source.getCalls.filter((k) => k !== "index.json");
    expect(chunkGets).toHaveLength(1);
  });

  it("cache: second run reads sealed chunks from cache, re-fetches the hot head", async () => {
    await publish(
      source,
      [{ from: 1n, to: 3n, events: [event(1n), event(2n)] }],
      { from: 3n, to: 5n, events: [event(3n)] },
    );
    const cache = new MemStore();
    const client = new Client({ source, cache });

    const first = await collect(client.streamEvents(PID));
    expect(cache.putCalls).toContain(`${PID}-[0x1,0x3).jsonl.gz`); // sealed chunk cached
    expect(cache.putCalls.some((k) => k.includes(".hot."))).toBe(false); // hot head not cached

    source.getCalls = [];
    const second = await collect(client.streamEvents(PID));
    expect(second).toEqual(first);
    // second run: manifest + hot head from source, sealed chunk from cache.
    const sealedGetsFromSource = source.getCalls.filter(
      (k) => k.endsWith(".jsonl.gz") && !k.includes(".hot."),
    );
    expect(sealedGetsFromSource).toHaveLength(0);
    expect(source.getCalls.some((k) => k.includes(".hot."))).toBe(true);
  });

  it("respects the concurrency cap on parallel fetches", async () => {
    const ranges = Array.from({ length: 6 }, (_, i) => ({
      from: BigInt(i),
      to: BigInt(i + 1),
      events: [event(BigInt(i))],
    }));
    const slow = new MemStore(20);
    await publish(slow, ranges);
    const client = new Client({ source: slow, concurrency: 2 });
    slow.maxInFlight = 0;
    await collect(client.streamEvents(PID));
    expect(slow.maxInFlight).toBeLessThanOrEqual(2);
    expect(slow.maxInFlight).toBeGreaterThan(1); // actually parallelized
  });

  it("surfaces a digest mismatch from the iterator", async () => {
    await publish(source, [{ from: 1n, to: 2n, events: [event(1n)] }]);
    // Replace the chunk with a *valid* gzip of different content, so the gzip
    // wrapper decodes cleanly but the recomputed sha256 won't match the manifest.
    const key = [...source.data.keys()].find((k) => k.endsWith(".jsonl.gz"))!;
    source.data.set(key, gzipSync(Buffer.from("tampered\n")));
    const client = new Client({ source });
    await expect(collect(client.streamEvents(PID))).rejects.toThrow(DigestMismatchError);
  });

  it("rejects a non-positive concurrency", () => {
    expect(() => new Client({ source, concurrency: 0 })).toThrow(/concurrency/);
  });

  describe("manifest signature verification", () => {
    const sign = (sk: string) => (bytes: Uint8Array) => signManifest(bytes, sk);

    it("streams when the signature matches the configured public key", async () => {
      const { secretKey, publicKey } = generateKeyPair();
      const all = await publish(source, [{ from: 1n, to: 2n, events: [event(1n)] }], undefined, sign(secretKey));
      const client = new Client({ source, publicKey });
      expect(await collect(client.streamEvents(PID))).toEqual(all);
    });

    it("skips verification when no publicKey is configured (opt-in)", async () => {
      // Signed manifest, but a client without a publicKey simply skips the check.
      const { secretKey } = generateKeyPair();
      await publish(source, [{ from: 1n, to: 2n, events: [event(1n)] }], undefined, sign(secretKey));
      const client = new Client({ source }); // no publicKey
      await expect(collect(client.streamEvents(PID))).resolves.toHaveLength(1);
    });

    it("rejects when the manifest was signed by a different key", async () => {
      const signer = generateKeyPair();
      const attackerSees = generateKeyPair();
      await publish(source, [{ from: 1n, to: 2n, events: [event(1n)] }], undefined, sign(signer.secretKey));
      const client = new Client({ source, publicKey: attackerSees.publicKey });
      await expect(collect(client.streamEvents(PID))).rejects.toThrow(ManifestSignatureError);
    });

    it("rejects when a publicKey is set but the manifest is unsigned", async () => {
      const { publicKey } = generateKeyPair();
      await publish(source, [{ from: 1n, to: 2n, events: [event(1n)] }]); // no signer
      const client = new Client({ source, publicKey });
      await expect(client.fetchManifest()).rejects.toThrow(ManifestSignatureError);
    });

    it("rejects a tampered manifest body", async () => {
      const { secretKey, publicKey } = generateKeyPair();
      await publish(source, [{ from: 1n, to: 2n, events: [event(1n)] }], undefined, sign(secretKey));
      // Tamper with index.json after signing; the signature no longer matches.
      const tampered = Buffer.from((await source.get("index.json"))!.toString("utf8").replace("0x1", "0x9"));
      await source.put("index.json", tampered);
      const client = new Client({ source, publicKey });
      await expect(client.fetchManifest()).rejects.toThrow(ManifestSignatureError);
    });
  });
});
