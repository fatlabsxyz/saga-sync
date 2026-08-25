#!/usr/bin/env node
// Retire a published stream: drop its manifest entry and delete its chunk objects.
//
// Not part of the publish loop — the orchestrator only ever appends. A stream is
// retired when its published chunks are known to be *wrong* rather than merely
// stale, which the block-range bookkeeping cannot detect on its own. The case
// this was written for: `railgun-1-main` was scraped under an incomplete event
// topic set, so its chunks are missing ~26% of Railgun's merkle leaves while
// looking perfectly well-formed. A hard 404 is better than serving that.
//
// Order is deliberate: the manifest entry goes first, then the objects. If the
// object deletes fail afterwards the leftovers are unreferenced and harmless; the
// other order would leave consumers holding a manifest that points at 404s.
//
// Dry-run unless --yes is passed. Signs the rewritten manifest when
// MANIFEST_SIGNING_KEY is set — pass the SAME key the stream was published with,
// or consumers pinning the public key will start failing verification.
//
// Usage:
//   node packages/producer/scripts/retire-stream.mjs \
//     --output-dir gs://pp-state --protocol railgun-1-main [--yes]

import { Manifest, signerFromEnv } from "@saga-sync/core";
import { createStore, parseStoreTarget } from "../dist/storage/index.js";

function fail(msg) {
  console.error(`error: ${msg}`);
  process.exit(1);
}

function parseArgs(argv) {
  const out = { target: null, protocol: null, apply: false };
  for (let i = 0; i < argv.length; i++) {
    const [flag, inline] = argv[i].split("=", 2);
    const value = () => inline ?? argv[++i];
    switch (flag) {
      case "--output-dir": out.target = value(); break;
      case "--protocol": out.protocol = value(); break;
      case "--yes": out.apply = true; break;
      case "--help": case "-h":
        console.log(
          "usage: retire-stream.mjs --output-dir <gs://bucket[/prefix]|dir> --protocol <id> [--yes]\n" +
            "\nWithout --yes this only reports what would be removed.",
        );
        process.exit(0);
        break;
      default: fail(`unknown flag: ${flag}`);
    }
  }
  if (!out.target) fail("--output-dir is required");
  if (!out.protocol) fail("--protocol is required");
  return out;
}

async function main() {
  const { target, protocol, apply } = parseArgs(process.argv.slice(2));

  const signer = signerFromEnv();
  const store = createStore({ ...parseStoreTarget(target), dryRun: false });
  const manifest = await Manifest.load(store, "index.json", signer ? { signer } : {});

  if (!manifest.protocolIds().includes(protocol)) {
    fail(`manifest at ${target} has no stream "${protocol}" (has: ${manifest.protocolIds().join(", ")})`);
  }

  const sealed = manifest.sealedChunks(protocol);
  const hot = manifest.hotHead(protocol);
  const files = [...sealed.map((c) => c.file), ...(hot ? [hot.file] : [])];
  const bytes = [...sealed, ...(hot ? [hot] : [])].reduce((n, c) => n + Number(BigInt(c.size)), 0);

  console.log(`stream:    ${protocol} @ ${target}`);
  console.log(`covers:    ${manifest.firstCoveredBlock(protocol)} → ${manifest.lastCoveredBlock(protocol)}`);
  console.log(`objects:   ${files.length} (${sealed.length} sealed${hot ? " + 1 hot head" : ""}), ${(bytes / 1e6).toFixed(1)} MB`);
  console.log(`signing:   ${signer ? "enabled" : "DISABLED — the rewritten manifest will be unsigned"}`);

  if (!apply) {
    console.log("\ndry run — nothing changed. Re-run with --yes to apply.");
    for (const f of files.slice(0, 5)) console.log(`  would delete ${f}`);
    if (files.length > 5) console.log(`  … and ${files.length - 5} more`);
    return;
  }

  await manifest.removeProtocol(protocol);
  await manifest.flush();
  console.log(`\nmanifest rewritten without "${protocol}"`);

  let deleted = 0;
  const failed = [];
  for (const file of files) {
    try {
      await store.delete(file);
      deleted++;
    } catch (err) {
      failed.push(`${file}: ${err.message}`);
    }
  }
  // Both stores treat delete as idempotent (not-found is ignored), so this counts
  // keys confirmed gone, not keys that necessarily existed.
  console.log(`${deleted}/${files.length} object(s) now absent`);
  if (failed.length > 0) {
    for (const f of failed) console.error(`  failed: ${f}`);
    fail(`${failed.length} object(s) could not be deleted — they are unreferenced now, but clean them up`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
