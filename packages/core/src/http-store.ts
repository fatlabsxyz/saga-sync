import type { Store } from "./store.js";

// Read-only Store backed by HTTP(S) GET. Used by the client library to fetch a
// publisher's manifest and chunk files. Writes are not supported — HTTP is the
// consumer surface; publishers use DiskStore (or a future S3Store).
//
// Keys are appended to baseUrl as percent-encoded path segments. Chunk
// filenames contain `[`, `]`, `,`, `(` and `)` which are reserved characters,
// so the encoding matters: most static-file servers accept either form, but
// percent-encoding is the safe choice across CDNs and proxies.
export class HttpStore implements Store {
  private readonly baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.endsWith("/") ? baseUrl : baseUrl + "/";
  }

  private url(key: string): string {
    return this.baseUrl + encodeURIComponent(key);
  }

  async get(key: string): Promise<Uint8Array | null> {
    const url = this.url(key);
    const response = await fetch(url);
    if (response.status === 404) return null;
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} fetching ${url}`);
    }
    return new Uint8Array(await response.arrayBuffer());
  }

  async put(_key: string, _data: Uint8Array): Promise<void> {
    throw new Error("HttpStore is read-only: put is not supported");
  }

  async delete(_key: string): Promise<void> {
    throw new Error("HttpStore is read-only: delete is not supported");
  }

  async list(_prefix: string): Promise<string[]> {
    throw new Error("HttpStore: list is not supported (HTTP has no native directory listing)");
  }
}
