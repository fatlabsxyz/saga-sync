import { describe, it, expect } from "vitest";
import {
  generateKeyPair,
  publicKeyFromSecret,
  signManifest,
  verifyManifestSignature,
  verifyManifestSignatures,
  signerFromEnv,
  signersFromEnv,
  createSigner,
  algorithmForPublicKey,
  registeredAlgorithms,
  signatureAlgorithm,
  encodeSignatureEnvelope,
  parseSignatureEnvelope,
  SIGNATURE_ENVELOPE_VERSION,
  ManifestSignatureError,
} from "./signing.js";
// Registers secp256k1 for the whole test file — mirrors what a Node consumer
// (the client CLI, the producer) does.
import "./secp256k1.js";

const bytes = (s: string) => new TextEncoder().encode(s);

describe("signing", () => {
  it("generates a keypair whose public key derives from the secret", () => {
    const { secretKey, publicKey } = generateKeyPair();
    expect(secretKey).toMatch(/^0x[0-9a-f]{64}$/);
    expect(publicKey).toMatch(/^0x[0-9a-f]{64}$/);
    expect(publicKeyFromSecret(secretKey)).toBe(publicKey);
  });

  it("round-trips: a signature over the bytes verifies with the public key", () => {
    const { secretKey, publicKey } = generateKeyPair();
    const msg = bytes('{"availableProtocols":{}}\n');
    const sig = signManifest(msg, secretKey);
    expect(sig).toMatch(/^0x[0-9a-f]{128}$/);
    expect(() => verifyManifestSignature(msg, sig, publicKey)).not.toThrow();
  });

  it("rejects tampered bytes", () => {
    const { secretKey, publicKey } = generateKeyPair();
    const sig = signManifest(bytes("original"), secretKey);
    expect(() => verifyManifestSignature(bytes("tampered"), sig, publicKey)).toThrow(
      ManifestSignatureError,
    );
  });

  it("rejects a signature from a different key", () => {
    const a = generateKeyPair();
    const b = generateKeyPair();
    const msg = bytes("hello");
    const sig = signManifest(msg, a.secretKey);
    expect(() => verifyManifestSignature(msg, sig, b.publicKey)).toThrow(ManifestSignatureError);
  });

  it("wraps malformed signature/key encodings as ManifestSignatureError (never returns false)", () => {
    const { publicKey } = generateKeyPair();
    expect(() => verifyManifestSignature(bytes("x"), "0xdead", publicKey)).toThrow(
      ManifestSignatureError,
    );
  });

  describe("signerFromEnv", () => {
    it("is undefined when the env var is unset", () => {
      expect(signerFromEnv({})).toBeUndefined();
    });

    it("returns a working signer for a valid key", () => {
      const { secretKey, publicKey } = generateKeyPair();
      const signer = signerFromEnv({ MANIFEST_SIGNING_KEY: secretKey });
      expect(signer).toBeTypeOf("function");
      const msg = bytes("manifest");
      expect(() => verifyManifestSignature(msg, signer!(msg), publicKey)).not.toThrow();
    });

    it("throws on a malformed key rather than deferring to first use", () => {
      expect(() => signerFromEnv({ MANIFEST_SIGNING_KEY: "0xnothex" })).toThrow(/not a valid/);
    });
  });

  describe("secp256k1", () => {
    it("is registered once the subpath module is imported", () => {
      expect(registeredAlgorithms()).toEqual(["ed25519", "secp256k1"]);
      expect(signatureAlgorithm("secp256k1").name).toBe("secp256k1");
    });

    it("round-trips with a compressed public key", () => {
      const { secretKey, publicKey } = generateKeyPair("secp256k1");
      expect(publicKey).toMatch(/^0x[0-9a-f]{66}$/); // 33 bytes, compressed
      expect(publicKeyFromSecret(secretKey, "secp256k1")).toBe(publicKey);
      const msg = bytes('{"availableProtocols":{}}\n');
      const sig = signManifest(msg, secretKey, "secp256k1");
      expect(sig).toMatch(/^0x[0-9a-f]{128}$/); // 64 bytes, compact r‖s
      expect(() => verifyManifestSignature(msg, sig, publicKey)).not.toThrow();
    });

    it("rejects tampered bytes", () => {
      const { secretKey, publicKey } = generateKeyPair("secp256k1");
      const sig = signManifest(bytes("original"), secretKey, "secp256k1");
      expect(() => verifyManifestSignature(bytes("tampered"), sig, publicKey)).toThrow(
        ManifestSignatureError,
      );
    });

    it("does not accept an Ed25519 signature, and vice versa", () => {
      const ed = generateKeyPair("ed25519");
      const k1 = generateKeyPair("secp256k1");
      const msg = bytes("manifest");
      const edSig = signManifest(msg, ed.secretKey, "ed25519");
      const k1Sig = signManifest(msg, k1.secretKey, "secp256k1");
      expect(() => verifyManifestSignature(msg, edSig, k1.publicKey)).toThrow(
        ManifestSignatureError,
      );
      expect(() => verifyManifestSignature(msg, k1Sig, ed.publicKey)).toThrow(
        ManifestSignatureError,
      );
    });
  });

  describe("algorithmForPublicKey", () => {
    it("infers the algorithm from the key length", () => {
      expect(algorithmForPublicKey(generateKeyPair("ed25519").publicKey)).toBe("ed25519");
      expect(algorithmForPublicKey(generateKeyPair("secp256k1").publicKey)).toBe("secp256k1");
    });

    it("throws on a length no algorithm claims", () => {
      expect(() => algorithmForPublicKey("0xdeadbeef")).toThrow(ManifestSignatureError);
    });

    it("throws on a key that is not hex", () => {
      expect(() => algorithmForPublicKey("0xzz")).toThrow(ManifestSignatureError);
    });
  });

  describe("signature envelope", () => {
    it("round-trips through encode/parse", () => {
      const ed = generateKeyPair("ed25519");
      const k1 = generateKeyPair("secp256k1");
      const msg = bytes("manifest");
      const entries = [
        { alg: "ed25519" as const, publicKey: ed.publicKey, signature: signManifest(msg, ed.secretKey) },
        {
          alg: "secp256k1" as const,
          publicKey: k1.publicKey,
          signature: signManifest(msg, k1.secretKey, "secp256k1"),
        },
      ];
      const raw = encodeSignatureEnvelope(entries);
      expect(JSON.parse(new TextDecoder().decode(raw)).version).toBe(SIGNATURE_ENVELOPE_VERSION);
      expect(parseSignatureEnvelope(raw)).toEqual(entries);
    });

    it("reads a LEGACY bare-hex signature as a single Ed25519 entry", () => {
      const { secretKey } = generateKeyPair();
      const sig = signManifest(bytes("manifest"), secretKey);
      const parsed = parseSignatureEnvelope(bytes(`${sig}\n`));
      expect(parsed).toEqual([{ alg: "ed25519", signature: sig }]);
    });

    it("rejects an empty, non-JSON, or structurally broken file", () => {
      expect(() => parseSignatureEnvelope(bytes("   "))).toThrow(/empty/);
      expect(() => parseSignatureEnvelope(bytes("not a signature"))).toThrow(
        /neither a JSON envelope/,
      );
      expect(() => parseSignatureEnvelope(bytes("{oops"))).toThrow(/not valid JSON/);
      expect(() => parseSignatureEnvelope(bytes('{"version":1}'))).toThrow(/no "signatures" array/);
      expect(() => parseSignatureEnvelope(bytes('{"signatures":[{"alg":"ed25519"}]}'))).toThrow(
        /missing "alg" or "signature"/,
      );
    });
  });

  describe("verifyManifestSignatures", () => {
    const msg = bytes('{"availableProtocols":{}}\n');
    const ed = generateKeyPair("ed25519");
    const k1 = generateKeyPair("secp256k1");
    const entries = [
      { alg: "ed25519" as const, publicKey: ed.publicKey, signature: signManifest(msg, ed.secretKey) },
      {
        alg: "secp256k1" as const,
        publicKey: k1.publicKey,
        signature: signManifest(msg, k1.secretKey, "secp256k1"),
      },
    ];

    it("accepts when EITHER pinned key verifies — the weakest-key trade", () => {
      expect(() => verifyManifestSignatures(msg, entries, [ed.publicKey])).not.toThrow();
      expect(() => verifyManifestSignatures(msg, entries, [k1.publicKey])).not.toThrow();
      expect(() => verifyManifestSignatures(msg, entries, [k1.publicKey, ed.publicKey])).not.toThrow();
    });

    it("rejects a key that signed nothing, naming what it looked for", () => {
      const stranger = generateKeyPair("ed25519");
      expect(() => verifyManifestSignatures(msg, entries, [stranger.publicKey])).toThrow(
        /no configured public key verified/,
      );
    });

    it("reports a missing algorithm rather than silently passing", () => {
      const edOnly = entries.filter((e) => e.alg === "ed25519");
      expect(() => verifyManifestSignatures(msg, edOnly, [k1.publicKey])).toThrow(
        /no secp256k1 signature is present/,
      );
    });

    it("rejects tampered bytes under every pinned key", () => {
      expect(() =>
        verifyManifestSignatures(bytes("tampered"), entries, [ed.publicKey, k1.publicKey]),
      ).toThrow(ManifestSignatureError);
    });

    it("requires at least one key and at least one signature", () => {
      expect(() => verifyManifestSignatures(msg, entries, [])).toThrow(/no public key configured/);
      expect(() => verifyManifestSignatures(msg, [], [ed.publicKey])).toThrow(/carries no signatures/);
    });

    it("verifies a LEGACY entry (no publicKey recorded) against a pinned Ed25519 key", () => {
      const legacy = parseSignatureEnvelope(bytes(signManifest(msg, ed.secretKey)));
      expect(() => verifyManifestSignatures(msg, legacy, [ed.publicKey])).not.toThrow();
    });

    it("is order-independent when one pinned key is unusable", () => {
      // A key of a length no registered algorithm claims stands in for the real
      // case (a secp256k1 key without the subpath imported): whichever side of
      // the good key it sits on, the good key must still win.
      const unusable = "0xdeadbeef";
      expect(() => verifyManifestSignatures(msg, entries, [unusable, ed.publicKey])).not.toThrow();
      expect(() => verifyManifestSignatures(msg, entries, [ed.publicKey, unusable])).not.toThrow();
      // Alone, it still reports why it could not be used.
      expect(() => verifyManifestSignatures(msg, entries, [unusable])).toThrow(
        /no registered signature algorithm uses a 4-byte public key/,
      );
    });
  });

  describe("signersFromEnv", () => {
    it("is empty when nothing is configured", () => {
      expect(signersFromEnv({})).toEqual([]);
    });

    it("returns one signer per configured algorithm, in algorithm order", () => {
      const ed = generateKeyPair("ed25519");
      const k1 = generateKeyPair("secp256k1");
      const signers = signersFromEnv({
        MANIFEST_SIGNING_KEY: ed.secretKey,
        MANIFEST_SIGNING_KEY_SECP256K1: k1.secretKey,
      });
      expect(signers.map((s) => s.alg)).toEqual(["ed25519", "secp256k1"]);
      expect(signers.map((s) => s.publicKey)).toEqual([ed.publicKey, k1.publicKey]);
      const msg = bytes("manifest");
      for (const s of signers) {
        expect(() => verifyManifestSignature(msg, s.sign(msg), s.publicKey)).not.toThrow();
      }
    });

    it("names the offending variable when a key is malformed", () => {
      expect(() => signersFromEnv({ MANIFEST_SIGNING_KEY_SECP256K1: "0xnothex" })).toThrow(
        /MANIFEST_SIGNING_KEY_SECP256K1 is not a valid secp256k1 secret/,
      );
    });
  });

  describe("createSigner", () => {
    it("reports its own public key and signs verifiably", () => {
      const { secretKey, publicKey } = generateKeyPair("secp256k1");
      const signer = createSigner(secretKey, "secp256k1");
      expect(signer).toMatchObject({ alg: "secp256k1", publicKey });
      const msg = bytes("manifest");
      expect(() => verifyManifestSignature(msg, signer.sign(msg), publicKey)).not.toThrow();
    });

    it("validates the secret eagerly", () => {
      expect(() => createSigner("0xnothex")).toThrow();
    });
  });
});
