import { resolve } from "node:path";
import type { Store } from "./store.js";
import { DiskStore } from "./disk-store.js";
import { DryRunStore } from "./dry-run-store.js";
import { HttpStore } from "./http-store.js";
import { GcsStore } from "./gcs-store.js";

export type { Store } from "./store.js";
export { DiskStore } from "./disk-store.js";
export { DryRunStore } from "./dry-run-store.js";
export { HttpStore } from "./http-store.js";
export { GcsStore } from "./gcs-store.js";

// Maps the config's storeSettings.protocol to a Store implementation. This is
// the single switch point — `s3`, `ftp` throw until their Store classes are
// added, at which point only this function changes. `dryRun` wraps the result
// so writes become no-ops.
//
// `http` constructs a read-only HttpStore (consumer-side). It uses
// `baseUrl` from settings, or falls back to baseDir for symmetry with the
// disk case.
export type StoreConfig = {
  protocol: "disk" | "s3" | "http" | "ftp" | "gcs";
  baseDir?: string;
  settings?: unknown;
  dryRun?: boolean;
};

export function createStore(cfg: StoreConfig): Store {
  let store: Store;
  switch (cfg.protocol) {
    case "disk":
      store = new DiskStore(cfg.baseDir ?? ".");
      break;
    case "http": {
      const settings = cfg.settings as { baseUrl?: string } | undefined;
      const baseUrl = settings?.baseUrl ?? cfg.baseDir;
      if (!baseUrl) throw new Error(`http store requires settings.baseUrl or baseDir`);
      store = new HttpStore(baseUrl);
      break;
    }
    case "gcs": {
      const settings = cfg.settings as { bucket?: string; prefix?: string } | undefined;
      if (!settings?.bucket) throw new Error(`gcs store requires settings.bucket`);
      store = new GcsStore(settings.bucket, { prefix: settings.prefix });
      break;
    }
    default:
      throw new Error(`store protocol "${cfg.protocol}" not implemented yet`);
  }
  return cfg.dryRun ? new DryRunStore(store) : store;
}

// Resolve a producer `--output-dir` argument to a StoreConfig (minus dryRun).
// A `gs://bucket[/prefix]` target selects the GCS store; anything else is a local
// filesystem directory. The single place the gs:// convention is parsed, shared
// by the orchestrator and chunk-builder CLIs.
export function parseStoreTarget(target: string): Omit<StoreConfig, "dryRun"> {
  if (target.startsWith("gs://")) {
    const rest = target.slice("gs://".length);
    const slash = rest.indexOf("/");
    const bucket = slash === -1 ? rest : rest.slice(0, slash);
    const prefix = slash === -1 ? undefined : rest.slice(slash + 1) || undefined;
    if (!bucket) throw new Error(`invalid gs:// target: ${target}`);
    return { protocol: "gcs", settings: { bucket, prefix } };
  }
  return { protocol: "disk", baseDir: resolve(target) };
}
