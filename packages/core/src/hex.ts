// 0x-prefixed hex string. A local alias replacing viem's `Hex`, so the shared
// kernel (@saga-sync/core) — and therefore @saga-sync/client — carries no viem
// dependency. Producer modules that interoperate with viem keep importing
// viem's own `Hex`, which is structurally identical to this.
export type Hex = `0x${string}`;
