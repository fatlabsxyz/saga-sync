import type { Store } from "./store.js";
import { DiskStore } from "./disk-store.js";
import { DryRunStore } from "./dry-run-store.js";
import { HttpStore } from "./http-store.js";

export type { Store } from "./store.js";
export { DiskStore } from "./disk-store.js";
export { DryRunStore } from "./dry-run-store.js";
export { HttpStore } from "./http-store.js";

// Maps the config's storeSettings.protocol to a Store implementation. This is
// the single switch point — `s3`, `ftp` throw until their Store classes are
// added, at which point only this function changes. `dryRun` wraps the result
// so writes become no-ops.
//
// `http` constructs a read-only HttpStore (consumer-side). It uses
// `baseUrl` from settings, or falls back to baseDir for symmetry with the
// disk case.
export type StoreConfig = {
  protocol: "disk" | "s3" | "http" | "ftp";
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
    default:
      throw new Error(`store protocol "${cfg.protocol}" not implemented yet`);
  }
  return cfg.dryRun ? new DryRunStore(store) : store;
}
