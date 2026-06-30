#!/usr/bin/env node
import { generateKeyPair } from "@saga-sync/core";

// Print a fresh Ed25519 manifest-signing keypair. The secret goes to the
// producer (MANIFEST_SIGNING_KEY env / Secret Manager); the public key is what
// consumers pin via --public-key (and, later, what a registry contract serves).
const { secretKey, publicKey } = generateKeyPair();
process.stdout.write(
  `# Ed25519 manifest-signing keypair — keep the secret secret\n` +
    `MANIFEST_SIGNING_KEY=${secretKey}\n` +
    `PUBLIC_KEY=${publicKey}\n`,
);
