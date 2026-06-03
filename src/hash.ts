import { sha256 } from "@noble/hashes/sha2.js";
import type { Hex } from "viem";

// 0x-prefixed lowercase hex sha256 of the given bytes. The one place the digest
// algorithm is named — chunk verification depends on the producer and the
// consumer hashing identically, so both go through here. (A future browser
// build swaps the body to native `crypto.subtle.digest`; this is the only file
// that changes.)
export function sha256Hex(bytes: Uint8Array): Hex {
  return `0x${Buffer.from(sha256(bytes)).toString("hex")}` as Hex;
}
