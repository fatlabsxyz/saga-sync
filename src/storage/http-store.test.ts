import { describe, it, expect, vi, afterEach } from "vitest";
import { HttpStore } from "./http-store.js";

function mockFetch(impl: (url: string) => Response | Promise<Response>) {
  const fn = vi.fn(async (input: string | URL | Request) => impl(String(input)));
  vi.stubGlobal("fetch", fn);
  return fn;
}

describe("HttpStore", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("GETs key under the base URL and returns a Buffer", async () => {
    const fetchFn = mockFetch(() => new Response(new Uint8Array([1, 2, 3]), { status: 200 }));
    const store = new HttpStore("https://cdn.example.com/state/");
    const got = await store.get("index.json");
    expect(got).not.toBeNull();
    expect([...got!]).toEqual([1, 2, 3]);
    expect(fetchFn).toHaveBeenCalledWith("https://cdn.example.com/state/index.json");
  });

  it("returns null on 404", async () => {
    mockFetch(() => new Response(null, { status: 404 }));
    const store = new HttpStore("https://cdn.example.com/state/");
    expect(await store.get("missing.gz")).toBeNull();
  });

  it("throws with status + URL on a non-2xx, non-404 response", async () => {
    mockFetch(() => new Response(null, { status: 503 }));
    const store = new HttpStore("https://cdn.example.com/state/");
    await expect(store.get("x.gz")).rejects.toThrow(/HTTP 503.*x\.gz/);
  });

  it("normalizes a missing trailing slash on the base URL", async () => {
    const fetchFn = mockFetch(() => new Response(new Uint8Array(), { status: 200 }));
    const store = new HttpStore("https://cdn.example.com/state");
    await store.get("a.gz");
    expect(fetchFn).toHaveBeenCalledWith("https://cdn.example.com/state/a.gz");
  });

  it("percent-encodes reserved characters in chunk filenames", async () => {
    const fetchFn = mockFetch(() => new Response(new Uint8Array(), { status: 200 }));
    const store = new HttpStore("https://cdn.example.com/");
    await store.get("p-[0x1,0x2).jsonl.gz");
    // encodeURIComponent encodes `[` and `,` but leaves `(` `)` `.` untouched.
    expect(fetchFn).toHaveBeenCalledWith(
      "https://cdn.example.com/p-%5B0x1%2C0x2).jsonl.gz",
    );
  });

  it("rejects writes — read-only", async () => {
    const store = new HttpStore("https://cdn.example.com/");
    await expect(store.put("a", Buffer.alloc(0))).rejects.toThrow(/read-only/);
    await expect(store.delete("a")).rejects.toThrow(/read-only/);
    await expect(store.list("")).rejects.toThrow(/not supported/);
  });
});
