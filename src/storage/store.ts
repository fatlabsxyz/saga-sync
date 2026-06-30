// One seam for all object persistence in the pipeline. DiskStore implements it
// today; S3Store / HttpStore can be added later by implementing the same
// interface, with no changes to the chunk-builder, manifest, or orchestrator.
//
// Keys are flat object names (e.g. "index.json",
// "tornado-cash-1-eth-0.1-[0x1,0x2).jsonl.gz"). The interface is async because
// the eventual S3/HTTP backends are inherently async — disk just resolves fast.
// Bytes are typed as Uint8Array (not Node's Buffer) so the read path stays
// browser-friendly: a Node Buffer *is* a Uint8Array, so DiskStore/GcsStore still
// satisfy this, while HttpStore returns a plain Uint8Array from `fetch`.
export interface Store {
  // Atomically write an object: a reader either sees the previous value or the
  // new one, never a partial write. (DiskStore: temp-file + rename. S3:
  // PutObject is atomic per-object.)
  put(key: string, data: Uint8Array): Promise<void>;

  // Read an object; resolves null when the key does not exist.
  get(key: string): Promise<Uint8Array | null>;

  // Delete an object; resolves without error if the key is already absent.
  delete(key: string): Promise<void>;

  // List keys that begin with `prefix`. Used by the hot-head orphan sweep.
  list(prefix: string): Promise<string[]>;
}
