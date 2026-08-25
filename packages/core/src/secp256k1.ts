import { secp256k1 } from "@noble/curves/secp256k1.js";
import type { SignatureAlgorithmImpl } from "./signing.js";
import { registerSignatureAlgorithm } from "./signing.js";

// secp256k1 (ECDSA) manifest signing, as an opt-in subpath.
//
// It lives here rather than in signing.ts so the default browser bundle keeps
// paying only for Ed25519. Measured with esbuild, the client's browser entry is
// 18.7 KB gzipped without this module and 25.3 KB with it — a third larger, for
// a curve most consumers never call. Importing this module registers the
// algorithm as a side effect:
//
//   import "@saga-sync/core/secp256k1";   // now --public-key accepts a secp256k1 key
//
// Node entry points (the client CLI, the producer) import it unconditionally —
// bundle size is not a concern there and it should Just Work.
//
// Encoding choices, both of which a verifier must match:
// - Public keys are the 33-byte COMPRESSED form. The 65-byte uncompressed form
//   is also accepted on verify, since @noble takes either and a key pasted from
//   Ethereum tooling is often uncompressed.
// - Signatures are the 64-byte compact (r‖s) form. No recovery byte: consumers
//   pin a public key, not an address, so recovery is never needed.
//
// ECDSA signs a 32-byte digest rather than a message; the sha256 pre-hash rule
// lives in signing.ts (`prehashForEcdsa`) so the producer and consumer cannot
// disagree about it.

export const secp256k1Algorithm: SignatureAlgorithmImpl = {
  name: "secp256k1",
  publicKeyLengths: [33, 65],
  randomSecretKey: () => secp256k1.utils.randomSecretKey(),
  getPublicKey: (secret) => secp256k1.getPublicKey(secret, true),
  sign: (digest, secret) => secp256k1.sign(digest, secret),
  verify: (signature, digest, publicKey) => secp256k1.verify(signature, digest, publicKey),
};

registerSignatureAlgorithm(secp256k1Algorithm);
