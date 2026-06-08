import type { Store } from "./store.js";

// The minimal slice of `@google-cloud/storage` this module uses. Declaring it
// locally (rather than importing the package's types) lets this file compile and
// be unit-tested without the heavy, producer-only SDK installed; the real client
// is loaded lazily at runtime (see defaultBucketProvider) and structurally
// satisfies these shapes. Tests inject a fake via `bucketProvider`.
export type SaveOptions = {
  contentType?: string;
  metadata?: { cacheControl?: string };
  resumable?: boolean;
};
export interface GcsFile {
  save(data: Uint8Array, opts: SaveOptions): Promise<void>;
  download(): Promise<[Uint8Array]>;
  delete(opts: { ignoreNotFound: boolean }): Promise<unknown>;
}
export interface GcsBucket {
  file(name: string): GcsFile;
  getFiles(opts: { prefix: string }): Promise<[Array<{ name: string }>]>;
}
export type BucketProvider = (bucket: string) => Promise<GcsBucket>;

const SEALED = /\.jsonl\.gz$/;
const HOT = /\.hot\.jsonl\.gz$/;

// Cache-Control by key. Sealed chunks are immutable + content-addressed, so they
// cache forever; the manifest and the hot head change every publish, so they get
// a short TTL that keeps a CDN / browser re-validating. The GcsStore sets this on
// every put — useful even without a CDN (browser/proxy caching), and exactly what
// a CDN in front of the bucket needs (cache-mode USE_ORIGIN_HEADERS).
export function cacheControlFor(key: string): string {
  if (SEALED.test(key) && !HOT.test(key)) return "public, max-age=31536000, immutable";
  return "public, max-age=30";
}

export function contentTypeFor(key: string): string {
  if (key.endsWith(".gz")) return "application/gzip";
  if (key.endsWith(".json")) return "application/json";
  return "application/octet-stream";
}

// Lazily import the real SDK so neither the consumer nor a disk/http run pays for
// it. The specifier is held in a variable so the type checker does not resolve
// the (optional) module at compile time.
const defaultBucketProvider: BucketProvider = async (bucket) => {
  const spec = "@google-cloud/storage";
  let mod: { Storage: new () => { bucket(name: string): GcsBucket } };
  try {
    mod = (await import(spec)) as unknown as typeof mod;
  } catch {
    throw new Error(
      `GcsStore needs the "@google-cloud/storage" package — run: npm install @google-cloud/storage`,
    );
  }
  return new mod.Storage().bucket(bucket);
};

export type GcsStoreOptions = {
  // Optional object-name prefix within the bucket (e.g. "v1/"). Keys are stored
  // and listed relative to it.
  prefix?: string;
  // Test/seam hook — override how the bucket handle is obtained.
  bucketProvider?: BucketProvider;
};

// Store backed by a Google Cloud Storage bucket (producer write-side; consumers
// read the same objects over plain HTTP via HttpStore). GCS object writes are
// atomic and strongly consistent, so no temp-file+rename dance is needed.
export class GcsStore implements Store {
  private readonly prefix: string;
  private readonly provider: BucketProvider;
  private bucketHandle?: Promise<GcsBucket>;

  constructor(
    private readonly bucketName: string,
    opts: GcsStoreOptions = {},
  ) {
    this.prefix = opts.prefix ? opts.prefix.replace(/\/+$/, "") + "/" : "";
    this.provider = opts.bucketProvider ?? defaultBucketProvider;
  }

  private bucket(): Promise<GcsBucket> {
    return (this.bucketHandle ??= this.provider(this.bucketName));
  }

  private obj(key: string): string {
    return this.prefix + key;
  }

  async put(key: string, data: Uint8Array): Promise<void> {
    const file = (await this.bucket()).file(this.obj(key));
    await file.save(data, {
      contentType: contentTypeFor(key),
      metadata: { cacheControl: cacheControlFor(key) },
      resumable: false,
    });
  }

  async get(key: string): Promise<Uint8Array | null> {
    const file = (await this.bucket()).file(this.obj(key));
    try {
      const [buf] = await file.download();
      return buf;
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  async delete(key: string): Promise<void> {
    const file = (await this.bucket()).file(this.obj(key));
    await file.delete({ ignoreNotFound: true });
  }

  async list(prefix: string): Promise<string[]> {
    const [files] = await (await this.bucket()).getFiles({ prefix: this.obj(prefix) });
    return files.map((f) => f.name.slice(this.prefix.length));
  }
}

function isNotFound(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: number }).code === 404;
}
