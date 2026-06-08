import { ed25519 } from "@noble/curves/ed25519.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import type { Hex } from "viem";

// Manifest signing — the one place Ed25519 lives (sibling of hash.ts). A detached
// signature over the exact index.json bytes authenticates the publisher; because
// the manifest holds every chunk's sha256 digest, one signature transitively
// authenticates the whole dataset. Keys and signatures are 0x-prefixed hex, like
// every other hash in the repo. (A future browser build can swap the body to
// native crypto.subtle Ed25519, exactly as planned for hashing.)

function toHex(bytes: Uint8Array): Hex {
  return `0x${bytesToHex(bytes)}` as Hex;
}

function fromHex(hex: string): Uint8Array {
  return hexToBytes(hex.startsWith("0x") ? hex.slice(2) : hex);
}

// A function that signs already-serialized manifest bytes. The Manifest calls one
// of these on every persist when configured.
export type ManifestSigner = (bytes: Uint8Array) => Hex;

export class ManifestSignatureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ManifestSignatureError";
  }
}

export type KeyPair = { secretKey: Hex; publicKey: Hex };

// Fresh Ed25519 keypair. The secret is a 32-byte seed; keep it secret.
export function generateKeyPair(): KeyPair {
  const secret = ed25519.utils.randomSecretKey();
  return { secretKey: toHex(secret), publicKey: toHex(ed25519.getPublicKey(secret)) };
}

// The public key (0x-hex) for a given secret — used to validate a configured key
// and to derive what consumers should pin.
export function publicKeyFromSecret(secretKey: string): Hex {
  return toHex(ed25519.getPublicKey(fromHex(secretKey)));
}

// Detached Ed25519 signature over the manifest bytes, 0x-hex.
export function signManifest(bytes: Uint8Array, secretKey: string): Hex {
  return toHex(ed25519.sign(bytes, fromHex(secretKey)));
}

// Verify a detached signature over the manifest bytes. Throws
// ManifestSignatureError on any failure (bad key/sig encoding or a real
// mismatch) — never returns false, so callers can treat a clean return as proof.
export function verifyManifestSignature(
  bytes: Uint8Array,
  signature: string,
  publicKey: string,
): void {
  let ok: boolean;
  try {
    ok = ed25519.verify(fromHex(signature), bytes, fromHex(publicKey));
  } catch (err) {
    throw new ManifestSignatureError(
      `manifest signature could not be checked: ${(err as Error).message}`,
    );
  }
  if (!ok) {
    throw new ManifestSignatureError("manifest signature does not match the configured public key");
  }
}

// Build a signer from the MANIFEST_SIGNING_KEY env var (a 0x-hex 32-byte seed),
// or undefined if unset. Validates the key eagerly so a bad secret fails at
// startup, not on the first persist.
export function signerFromEnv(env: NodeJS.ProcessEnv = process.env): ManifestSigner | undefined {
  const key = env.MANIFEST_SIGNING_KEY;
  if (!key) return undefined;
  try {
    publicKeyFromSecret(key); // throws if the seed is malformed
  } catch (err) {
    throw new Error(`MANIFEST_SIGNING_KEY is not a valid Ed25519 secret: ${(err as Error).message}`);
  }
  return (bytes) => signManifest(bytes, key);
}
