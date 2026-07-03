import { describe, it, expect, vi } from "vitest";
import {
  GcsStore,
  cacheControlFor,
  contentTypeFor,
  withRetry,
  type GcsBucket,
  type GcsFile,
  type SaveOptions,
} from "./gcs-store.js";

// In-memory fake of the GCS bucket surface, capturing the metadata `put` sets.
type Stored = { data: Buffer; opts: SaveOptions };
class FakeBucket implements GcsBucket {
  readonly objects = new Map<string, Stored>();
  file(name: string): GcsFile {
    const objects = this.objects;
    return {
      async save(data: Buffer, opts: SaveOptions) {
        objects.set(name, { data: Buffer.from(data), opts });
      },
      async download(): Promise<[Buffer]> {
        const hit = objects.get(name);
        if (!hit) throw Object.assign(new Error("Not Found"), { code: 404 });
        return [hit.data];
      },
      async delete() {
        objects.delete(name);
        return undefined;
      },
    };
  }
  async getFiles({ prefix }: { prefix: string }): Promise<[Array<{ name: string }>]> {
    return [[...this.objects.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name }))];
  }
}

const storeOn = (bucket: FakeBucket, prefix?: string) =>
  new GcsStore("test-bucket", { prefix, bucketProvider: async () => bucket });

describe("cacheControlFor", () => {
  it("marks sealed chunks immutable", () => {
    expect(cacheControlFor("p-[0x1,0x2).jsonl.gz")).toBe("public, max-age=31536000, immutable");
  });
  it("gives the manifest and hot head a short TTL", () => {
    expect(cacheControlFor("index.json")).toBe("public, max-age=30");
    expect(cacheControlFor("p-[0x1,0x2).hot.jsonl.gz")).toBe("public, max-age=30");
  });
});

describe("contentTypeFor", () => {
  it("maps extensions", () => {
    expect(contentTypeFor("x.jsonl.gz")).toBe("application/gzip");
    expect(contentTypeFor("index.json")).toBe("application/json");
    expect(contentTypeFor("x.bin")).toBe("application/octet-stream");
  });
});

describe("withRetry (GCS 429 object mutation rate limit)", () => {
  it("retries a 429 with backoff and eventually succeeds", async () => {
    const rnd = vi.spyOn(Math, "random").mockReturnValue(0); // instant backoff
    let calls = 0;
    const out = await withRetry(async () => {
      calls += 1;
      if (calls <= 2) throw Object.assign(new Error("rate limit for object mutation"), { code: 429 });
      return "ok";
    });
    expect(out).toBe("ok");
    expect(calls).toBe(3);
    rnd.mockRestore();
  });

  it("propagates a non-rate-limit error immediately", async () => {
    let calls = 0;
    await expect(
      withRetry(async () => {
        calls += 1;
        throw Object.assign(new Error("boom"), { code: 500 });
      }),
    ).rejects.toThrow(/boom/);
    expect(calls).toBe(1); // no retry
  });
});

describe("GcsStore", () => {
  it("put sets content-type and cache-control per key", async () => {
    const bucket = new FakeBucket();
    const store = storeOn(bucket);
    await store.put("p-[0x1,0x2).jsonl.gz", Buffer.from("sealed"));
    await store.put("index.json", Buffer.from("{}"));

    const sealed = bucket.objects.get("p-[0x1,0x2).jsonl.gz")!;
    expect(sealed.opts.contentType).toBe("application/gzip");
    expect(sealed.opts.metadata?.cacheControl).toBe("public, max-age=31536000, immutable");

    const manifest = bucket.objects.get("index.json")!;
    expect(manifest.opts.contentType).toBe("application/json");
    expect(manifest.opts.metadata?.cacheControl).toBe("public, max-age=30");
  });

  it("get round-trips and returns null for a missing key", async () => {
    const bucket = new FakeBucket();
    const store = storeOn(bucket);
    await store.put("a", Buffer.from("hello"));
    expect((await store.get("a"))?.toString()).toBe("hello");
    expect(await store.get("missing")).toBeNull();
  });

  it("delete is a no-op when absent", async () => {
    const store = storeOn(new FakeBucket());
    await expect(store.delete("nope")).resolves.toBeUndefined();
  });

  it("applies a prefix to keys and strips it on list", async () => {
    const bucket = new FakeBucket();
    const store = storeOn(bucket, "v1/");
    await store.put("index.json", Buffer.from("{}"));
    await store.put("p.jsonl.gz", Buffer.from("x"));
    expect([...bucket.objects.keys()].sort()).toEqual(["v1/index.json", "v1/p.jsonl.gz"]);
    expect((await store.list("")).sort()).toEqual(["index.json", "p.jsonl.gz"]);
    expect((await store.get("index.json"))?.toString()).toBe("{}");
  });
});
