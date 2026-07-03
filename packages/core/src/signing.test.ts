import { describe, it, expect } from "vitest";
import {
  generateKeyPair,
  publicKeyFromSecret,
  signManifest,
  verifyManifestSignature,
  signerFromEnv,
  ManifestSignatureError,
} from "./signing.js";

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
});
