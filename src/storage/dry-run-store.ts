import type { Store } from "./store.js";

// Wraps another Store so that writes (put, delete) become no-ops while reads
// (get, list) pass through. Lets `--dry-run` be expressed entirely at the
// storage layer — every other class (ChunkArchive, Manifest) stays oblivious.
export class DryRunStore implements Store {
  constructor(private readonly inner: Store) {}

  async put(_key: string, _data: Uint8Array): Promise<void> {
    /* dry-run: discard writes */
  }

  async delete(_key: string): Promise<void> {
    /* dry-run: discard deletes */
  }

  get(key: string): Promise<Uint8Array | null> {
    return this.inner.get(key);
  }

  list(prefix: string): Promise<string[]> {
    return this.inner.list(prefix);
  }
}
