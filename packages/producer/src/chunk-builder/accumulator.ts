import type { CanonicalEvent } from "../scraper/normalize.js";

export type CompletedChunk = { events: CanonicalEvent[]; from: bigint; to: bigint };
export type Trailing = { events: CanonicalEvent[]; fromBlock: bigint };

// Block-aligned chunk partitioning — pure, no I/O. Events are fed in
// (blockNumber, logIndex) order; the accumulator buffers the in-progress block
// separately and only commits it to the current chunk once the next block
// arrives. That guarantees chunk boundaries always fall *between* blocks, so a
// multi-event block can never be split across two chunks.
//
// `add` emits a completed chunk when feeding an event closed a block and the
// accumulated bytes had crossed the size limit. `finish` flushes the last
// in-progress block and hands back the trailing accumulator — the caller seals
// it as a final chunk or carries it forward as a hot head.
export class ChunkAccumulator {
  private accumulated: CanonicalEvent[] = [];
  private accumulatedBytes = 0;
  private pending: CanonicalEvent[] = [];
  private pendingBytes = 0;
  private pendingBlock: bigint | null = null;

  constructor(
    private readonly sizeLimit: number,
    private chunkFrom: bigint,
  ) {}

  add(event: CanonicalEvent): CompletedChunk | null {
    const eventBlock = BigInt(event.blockNumber);
    const lineBytes = Buffer.byteLength(JSON.stringify(event) + "\n", "utf8");
    let completed: CompletedChunk | null = null;

    if (this.pendingBlock !== null && eventBlock !== this.pendingBlock) {
      // The pending block is finished — commit it to the current chunk,
      // sealing first if doing so would overflow the size limit.
      if (this.wouldOverflow()) {
        completed = this.cut(this.pendingBlock);
      }
      this.commitPending();
    }

    this.pendingBlock = eventBlock;
    this.pending.push(event);
    this.pendingBytes += lineBytes;
    return completed;
  }

  finish(): { completed: CompletedChunk | null; trailing: Trailing } {
    let completed: CompletedChunk | null = null;
    if (this.pending.length > 0 && this.pendingBlock !== null) {
      if (this.wouldOverflow()) {
        completed = this.cut(this.pendingBlock);
      }
      this.commitPending();
    }
    return {
      completed,
      trailing: { events: this.accumulated, fromBlock: this.chunkFrom },
    };
  }

  private wouldOverflow(): boolean {
    return (
      this.accumulatedBytes + this.pendingBytes > this.sizeLimit &&
      this.accumulated.length > 0
    );
  }

  private commitPending(): void {
    this.accumulated.push(...this.pending);
    this.accumulatedBytes += this.pendingBytes;
    this.pending = [];
    this.pendingBytes = 0;
  }

  // Close the current chunk at `to` and start a fresh one.
  private cut(to: bigint): CompletedChunk {
    const chunk: CompletedChunk = { events: this.accumulated, from: this.chunkFrom, to };
    this.chunkFrom = to;
    this.accumulated = [];
    this.accumulatedBytes = 0;
    return chunk;
  }
}
