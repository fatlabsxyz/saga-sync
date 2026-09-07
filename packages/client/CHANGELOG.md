# @saga-sync/client

## 0.2.0

### Minor Changes

- 007dd2b: Add secp256k1 signing alongside Ed25519, and Subsquid-backed sources for Railgun. All changes are backward compatible.
  
  - **Signing (core):** manifests can carry multiple signatures (Ed25519 and/or secp256k1) in a versioned `index.json.sigs` envelope; the legacy single Ed25519 `.sig` file is still produced and verified. Adds `signersFromEnv`, `createSigner`, `verifyManifestSignatures`, a pluggable signature-algorithm registry, ECDSA prehashing, and envelope encode/parse helpers.
  - **Entity records (core, client):** new `CanonicalEntity` / `CanonicalRecord` types and the `isEntityRecord` guard; the client verifies multi-signature manifests and consumes entity records.
  - **Sources (producer):** serve Railgun operations from Subsquid as entity records, add an RPC log source behind a shared source interface, and scrape the full Railgun event set across the contract's V1 / V2.0 / V2.1 upgrades, including legacy commitments.
  - **Tooling (producer):** add secp256k1 key generation, the Railgun cross-check and stream-retire scripts, and default the deploy to a local Docker build.

### Patch Changes

- Updated dependencies [007dd2b]
  - @saga-sync/core@0.2.0
