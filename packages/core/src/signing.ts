import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import type { Hex } from "./hex.js";

// Manifest signing — the one place signature algorithms live (sibling of
// hash.ts). A detached signature over the exact index.json bytes authenticates
// the publisher; because the manifest holds every chunk's sha256 digest, one
// signature transitively authenticates the whole dataset. Keys and signatures
// are 0x-prefixed hex, like every other hash in the repo.
//
// A manifest may carry SEVERAL signatures — one per algorithm — all over the
// identical bytes, so a consumer can verify with whichever key it holds. Note
// what that means for the threat model: any single valid signature is accepted,
// so the trust root is only as strong as the WEAKEST configured key. That is a
// deliberate trade for reach (secp256k1 unlocks Ethereum tooling and hardware
// wallets); it is not a strengthening. Requiring k-of-n would be the opposite
// feature and is not what this implements.
//
// Ed25519 is built in because it is small and isomorphic. secp256k1 lives behind
// the "@saga-sync/core/secp256k1" subpath so a browser consumer that only needs
// Ed25519 does not pay for a curve it never calls — import that module (for its
// side effect) to enable it. Measured with esbuild: the browser client entry is
// 18.7 KB gzipped without it and 25.3 KB with it.

function toHex(bytes: Uint8Array): Hex {
  return `0x${bytesToHex(bytes)}` as Hex;
}

function fromHex(hex: string): Uint8Array {
  return hexToBytes(hex.startsWith("0x") ? hex.slice(2) : hex);
}

export class ManifestSignatureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ManifestSignatureError";
  }
}

// --- algorithm registry ------------------------------------------------------

export type SignatureAlgorithm = "ed25519" | "secp256k1";

// What an algorithm must provide to sign manifests. `publicKeyLengths` is the
// set of valid public-key byte lengths, used to infer the algorithm from a key a
// consumer pinned — so `--public-key` needs no companion `--alg` flag.
export type SignatureAlgorithmImpl = {
  name: SignatureAlgorithm;
  publicKeyLengths: number[];
  randomSecretKey(): Uint8Array;
  getPublicKey(secret: Uint8Array): Uint8Array;
  sign(bytes: Uint8Array, secret: Uint8Array): Uint8Array;
  verify(signature: Uint8Array, bytes: Uint8Array, publicKey: Uint8Array): boolean;
};

const ALGORITHMS = new Map<SignatureAlgorithm, SignatureAlgorithmImpl>();

export function registerSignatureAlgorithm(impl: SignatureAlgorithmImpl): void {
  ALGORITHMS.set(impl.name, impl);
}

export function registeredAlgorithms(): SignatureAlgorithm[] {
  return [...ALGORITHMS.keys()].sort();
}

// Look up an algorithm, with an error that says how to enable it — an
// unregistered secp256k1 is the expected failure for a browser consumer who
// pinned a secp256k1 key but never imported the subpath.
export function signatureAlgorithm(name: SignatureAlgorithm): SignatureAlgorithmImpl {
  const impl = ALGORITHMS.get(name);
  if (!impl) {
    throw new ManifestSignatureError(
      `signature algorithm "${name}" is not available` +
        (name === "secp256k1" ? ` — import "@saga-sync/core/secp256k1" to enable it` : "") +
        `. Available: ${registeredAlgorithms().join(", ") || "(none)"}`,
    );
  }
  return impl;
}

const ED25519: SignatureAlgorithmImpl = {
  name: "ed25519",
  publicKeyLengths: [32],
  randomSecretKey: () => ed25519.utils.randomSecretKey(),
  getPublicKey: (secret) => ed25519.getPublicKey(secret),
  sign: (bytes, secret) => ed25519.sign(bytes, secret),
  verify: (signature, bytes, publicKey) => ed25519.verify(signature, bytes, publicKey),
};
registerSignatureAlgorithm(ED25519);

// ECDSA over secp256k1 signs a 32-byte digest, not a message. Both the producer
// and the consumer must pre-hash identically, so the rule lives here rather than
// in the algorithm module: sha256, the same digest the chunks use.
export function prehashForEcdsa(bytes: Uint8Array): Uint8Array {
  return sha256(bytes);
}

// Infer the algorithm from a pinned public key's length. Throws when no
// registered algorithm claims that length, or when two do (which no current
// pair does: Ed25519 is 32 bytes, secp256k1 is 33 or 65).
export function algorithmForPublicKey(publicKey: string): SignatureAlgorithm {
  let bytes: Uint8Array;
  try {
    bytes = fromHex(publicKey);
  } catch (err) {
    throw new ManifestSignatureError(`public key is not valid hex: ${(err as Error).message}`);
  }
  const matches = [...ALGORITHMS.values()].filter((a) => a.publicKeyLengths.includes(bytes.length));
  if (matches.length === 1) return matches[0]!.name;
  if (matches.length === 0) {
    throw new ManifestSignatureError(
      `no registered signature algorithm uses a ${bytes.length}-byte public key ` +
        `(registered: ${registeredAlgorithms().join(", ") || "none"}). ` +
        `A 33- or 65-byte key is secp256k1 — import "@saga-sync/core/secp256k1" to enable it.`,
    );
  }
  throw new ManifestSignatureError(
    `a ${bytes.length}-byte public key is ambiguous between ${matches.map((m) => m.name).join(", ")}`,
  );
}

// --- keys and signers --------------------------------------------------------

export type KeyPair = { secretKey: Hex; publicKey: Hex; alg: SignatureAlgorithm };

// Fresh keypair for the given algorithm (default Ed25519). The secret is a
// 32-byte seed; keep it secret.
export function generateKeyPair(alg: SignatureAlgorithm = "ed25519"): KeyPair {
  const impl = signatureAlgorithm(alg);
  const secret = impl.randomSecretKey();
  return { secretKey: toHex(secret), publicKey: toHex(impl.getPublicKey(secret)), alg };
}

// The public key (0x-hex) for a given secret — used to validate a configured key
// and to derive what consumers should pin.
export function publicKeyFromSecret(
  secretKey: string,
  alg: SignatureAlgorithm = "ed25519",
): Hex {
  return toHex(signatureAlgorithm(alg).getPublicKey(fromHex(secretKey)));
}

// Detached signature over the manifest bytes, 0x-hex.
export function signManifest(
  bytes: Uint8Array,
  secretKey: string,
  alg: SignatureAlgorithm = "ed25519",
): Hex {
  const impl = signatureAlgorithm(alg);
  const message = alg === "ed25519" ? bytes : prehashForEcdsa(bytes);
  return toHex(impl.sign(message, fromHex(secretKey)));
}

// A bare function that signs already-serialized manifest bytes. Kept for
// backward compatibility: it cannot report its own public key, so a Manifest
// configured with one can only emit the legacy single-signature file.
export type ManifestSigner = (bytes: Uint8Array) => Hex;

// A signer that knows its own identity, so the envelope can name the algorithm
// and public key each signature verifies against.
export type ManifestKeySigner = {
  alg: SignatureAlgorithm;
  publicKey: Hex;
  sign: (bytes: Uint8Array) => Hex;
};

// Build a signer from a secret, validating it eagerly so a bad key fails at
// startup rather than on the first persist.
export function createSigner(
  secretKey: string,
  alg: SignatureAlgorithm = "ed25519",
): ManifestKeySigner {
  const publicKey = publicKeyFromSecret(secretKey, alg); // throws on a malformed seed
  return { alg, publicKey, sign: (bytes) => signManifest(bytes, secretKey, alg) };
}

// Env var per algorithm — Secret Manager entries are provisioned one per secret,
// so this maps 1:1 onto how they are already stored. MANIFEST_SIGNING_KEY keeps
// its original Ed25519 meaning.
const ENV_KEYS: { env: string; alg: SignatureAlgorithm }[] = [
  { env: "MANIFEST_SIGNING_KEY", alg: "ed25519" },
  { env: "MANIFEST_SIGNING_KEY_SECP256K1", alg: "secp256k1" },
];

// Every configured signing key, in algorithm order. Empty when none is set.
export function signersFromEnv(env: NodeJS.ProcessEnv = process.env): ManifestKeySigner[] {
  const signers: ManifestKeySigner[] = [];
  for (const { env: name, alg } of ENV_KEYS) {
    const key = env[name];
    if (!key) continue;
    try {
      signers.push(createSigner(key, alg));
    } catch (err) {
      throw new Error(`${name} is not a valid ${alg} secret: ${(err as Error).message}`);
    }
  }
  return signers;
}

// Backward-compatible single-signer accessor: the Ed25519 key only.
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

// --- the signature envelope --------------------------------------------------

export const SIGNATURE_ENVELOPE_VERSION = 1;

// One signature in the envelope. `publicKey` is absent only when the entry came
// from the legacy bare-hex `.sig` file, which carries no key.
export type SignatureEntry = {
  alg: SignatureAlgorithm;
  publicKey?: Hex;
  signature: Hex;
};

// Serialize the envelope written to `index.json.sigs`. Field order is fixed and
// entries keep signer order so the bytes are stable across publishes.
export function encodeSignatureEnvelope(entries: SignatureEntry[]): Uint8Array {
  const body = {
    version: SIGNATURE_ENVELOPE_VERSION,
    signatures: entries.map((e) => ({
      alg: e.alg,
      ...(e.publicKey !== undefined ? { publicKey: e.publicKey } : {}),
      signature: e.signature,
    })),
  };
  return new TextEncoder().encode(JSON.stringify(body, null, 2) + "\n");
}

// Parse a signature file. Accepts both the envelope and the LEGACY bare `0x…`
// hex form, so a caller can point this at either object and get one shape back;
// a legacy signature yields a single Ed25519 entry with no public key.
export function parseSignatureEnvelope(raw: Uint8Array): SignatureEntry[] {
  const text = new TextDecoder().decode(raw).trim();
  if (text.length === 0) throw new ManifestSignatureError("signature file is empty");

  if (!text.startsWith("{")) {
    if (!/^0x[0-9a-fA-F]+$/.test(text)) {
      throw new ManifestSignatureError(
        "signature file is neither a JSON envelope nor a 0x-hex signature",
      );
    }
    return [{ alg: "ed25519", signature: text.toLowerCase() as Hex }];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new ManifestSignatureError(`signature envelope is not valid JSON: ${(err as Error).message}`);
  }
  const list = (parsed as { signatures?: unknown }).signatures;
  if (!Array.isArray(list)) {
    throw new ManifestSignatureError('signature envelope has no "signatures" array');
  }
  return list.map((entry, i) => {
    const e = entry as Partial<SignatureEntry>;
    if (typeof e.alg !== "string" || typeof e.signature !== "string") {
      throw new ManifestSignatureError(
        `signature envelope entry ${i} is missing "alg" or "signature"`,
      );
    }
    return {
      alg: e.alg as SignatureAlgorithm,
      ...(typeof e.publicKey === "string" ? { publicKey: e.publicKey.toLowerCase() as Hex } : {}),
      signature: e.signature.toLowerCase() as Hex,
    };
  });
}

// --- verification ------------------------------------------------------------

// Verify one detached signature over the manifest bytes. Throws
// ManifestSignatureError on any failure (bad key/sig encoding or a real
// mismatch) — never returns false, so callers can treat a clean return as proof.
// The algorithm is inferred from the public key's length unless given.
export function verifyManifestSignature(
  bytes: Uint8Array,
  signature: string,
  publicKey: string,
  alg: SignatureAlgorithm = algorithmForPublicKey(publicKey),
): void {
  const impl = signatureAlgorithm(alg);
  const message = alg === "ed25519" ? bytes : prehashForEcdsa(bytes);
  let ok: boolean;
  try {
    ok = impl.verify(fromHex(signature), message, fromHex(publicKey));
  } catch (err) {
    throw new ManifestSignatureError(
      `manifest signature could not be checked: ${(err as Error).message}`,
    );
  }
  if (!ok) {
    throw new ManifestSignatureError("manifest signature does not match the configured public key");
  }
}

// Verify a manifest against a set of pinned public keys: the manifest is
// accepted when ANY pinned key verifies a signature of its own algorithm (see
// the weakest-key note at the top of this file). Throws if none does.
//
// Entries whose `alg` does not match the pinned key are skipped rather than
// failing, so a manifest may carry algorithms this build cannot verify.
export function verifyManifestSignatures(
  bytes: Uint8Array,
  entries: SignatureEntry[],
  publicKeys: string[],
): void {
  if (publicKeys.length === 0) throw new ManifestSignatureError("no public key configured");
  if (entries.length === 0) throw new ManifestSignatureError("signature file carries no signatures");

  const failures: string[] = [];
  for (const publicKey of publicKeys) {
    // Everything for one key is wrapped, INCLUDING the algorithm lookup: a key
    // whose algorithm this build cannot load (secp256k1 without the subpath
    // imported) must not stop a later key from verifying. Otherwise the result
    // would depend on the order the keys were pinned in.
    try {
      const alg = algorithmForPublicKey(publicKey);
      const candidates = entries.filter((e) => e.alg === alg);
      if (candidates.length === 0) {
        failures.push(`no ${alg} signature is present`);
        continue;
      }
      for (const entry of candidates) {
        try {
          verifyManifestSignature(bytes, entry.signature, publicKey, alg);
          return; // one good signature is enough
        } catch (err) {
          failures.push(`${alg}: ${(err as Error).message}`);
        }
      }
    } catch (err) {
      failures.push((err as Error).message);
    }
  }
  throw new ManifestSignatureError(
    `no configured public key verified the manifest (${failures.join("; ")})`,
  );
}
