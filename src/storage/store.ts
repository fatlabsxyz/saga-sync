// One seam for all object persistence in the pipeline. DiskStore implements it
// today; S3Store / HttpStore can be added later by implementing the same
// interface, with no changes to the chunk-builder, manifest, or orchestrator.
//
// Keys are flat object names (e.g. "index.json",
// "tornado-cash-1-eth-0.1-[0x1,0x2).jsonl.gz"). The interface is async because
// the eventual S3/HTTP backends are inherently async — disk just resolves fast.
export interface Store {
  // Atomically write an object: a reader either sees the previous value or the
  // new one, never a partial write. (DiskStore: temp-file + rename. S3:
  // PutObject is atomic per-object.)
  put(key: string, data: Buffer): Promise<void>;

  // Read an object; resolves null when the key does not exist.
  get(key: string): Promise<Buffer | null>;

  // Delete an object; resolves without error if the key is already absent.
  delete(key: string): Promise<void>;

  // List keys that begin with `prefix`. Used by the hot-head orphan sweep.
  list(prefix: string): Promise<string[]>;
}
