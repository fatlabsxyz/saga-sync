import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import type { Hex } from "./hex.js";

// 0x-prefixed lowercase hex sha256 of the given bytes. The one place the digest
// algorithm is named — chunk verification depends on the producer and the
// consumer hashing identically, so both go through here. Pure JS + @noble's own
// hex (no Buffer), so it runs unchanged in a browser.
export function sha256Hex(bytes: Uint8Array): Hex {
  return `0x${bytesToHex(sha256(bytes))}` as Hex;
}
