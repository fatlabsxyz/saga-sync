import type { Hex } from "viem";
import type { Store } from "../storage/store.js";

const CURSOR_KEY = "cursor.json";

// The standalone scraper's resume pointer, keyed by the opaque protocol-instance
// id. `lastScrapedBlock` is the last block covered by a successful run; the next
// run resumes at lastScrapedBlock + 1. Only used by direct scraper CLI runs —
// the orchestrator derives resume points from the manifest instead.
export class Cursor {
  private constructor(
    private readonly store: Store,
    private readonly key: string,
    private data: Record<string, { lastScrapedBlock: Hex }>,
  ) {}

  static async load(store: Store, key: string = CURSOR_KEY): Promise<Cursor> {
    const raw = await store.get(key);
    if (!raw) return new Cursor(store, key, {});
    try {
      const data = JSON.parse(new TextDecoder().decode(raw)) as Record<
        string,
        { lastScrapedBlock: Hex }
      >;
      return new Cursor(store, key, data);
    } catch (err) {
      // A corrupt cursor is a hard error — silently treating it as empty would
      // re-scrape from the cold-start block and flood the downstream consumer.
      throw new Error(`cursor ${key}: ${(err as Error).message}`);
    }
  }

  lastScrapedBlock(protocolId: string): Hex | undefined {
    return this.data[protocolId]?.lastScrapedBlock;
  }

  // Atomic via the Store (DiskStore: temp-file + rename).
  async set(protocolId: string, lastScrapedBlock: Hex): Promise<void> {
    this.data[protocolId] = { lastScrapedBlock };
    await this.store.put(
      this.key,
      Buffer.from(JSON.stringify(this.data, null, 2) + "\n", "utf8"),
    );
  }
}
