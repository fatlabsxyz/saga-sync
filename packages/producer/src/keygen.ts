#!/usr/bin/env node
import { parseArgs } from "node:util";
import { generateKeyPair } from "@saga-sync/core";
import type { SignatureAlgorithm } from "@saga-sync/core";
import "@saga-sync/core/secp256k1";

// Print a fresh manifest-signing keypair. The secret goes to the producer
// (MANIFEST_SIGNING_KEY / MANIFEST_SIGNING_KEY_SECP256K1 env, or Secret Manager);
// the public key is what consumers pin via --public-key (and, later, what a
// registry contract serves).

const ENV_VAR: Record<SignatureAlgorithm, string> = {
  ed25519: "MANIFEST_SIGNING_KEY",
  secp256k1: "MANIFEST_SIGNING_KEY_SECP256K1",
};

const USAGE = `keygen — mint a manifest-signing keypair

Usage:
  keygen [--alg ed25519|secp256k1]

  --alg <name>   signature algorithm; default ed25519
  --help         show this message

A manifest may carry one signature per algorithm, and a consumer is accepted by
ANY of them — so every key you add is another way to forge a manifest. Add a
second algorithm for reach (secp256k1 works with Ethereum tooling), not for
strength.
`;

const { values } = parseArgs({
  options: { alg: { type: "string" }, help: { type: "boolean", default: false } },
});

if (values.help) {
  process.stdout.write(USAGE);
  process.exit(0);
}

const alg = (values.alg ?? "ed25519") as SignatureAlgorithm;
if (!(alg in ENV_VAR)) {
  process.stderr.write(`keygen: unknown --alg "${alg}" (expected ed25519 or secp256k1)\n`);
  process.exit(1);
}

const { secretKey, publicKey } = generateKeyPair(alg);
process.stdout.write(
  `# ${alg} manifest-signing keypair — keep the secret secret\n` +
    `${ENV_VAR[alg]}=${secretKey}\n` +
    `PUBLIC_KEY=${publicKey}\n`,
);
