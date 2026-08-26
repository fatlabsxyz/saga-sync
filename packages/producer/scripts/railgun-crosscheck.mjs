#!/usr/bin/env node
// Cross-check a published Railgun stream against the RAILGUN Subsquid index.
//
// The stream carries raw logs; the squid carries decoded per-leaf entities. This
// script decodes our logs the way a consumer (e.g. kohaku's UtxoSyncer) would and
// asserts the resulting commitment / nullifier / unshield sets are *identical* to
// the squid's for the same block range. That is the acceptance test for the event
// coverage of `railgun-1-smartwallet`: a missing event topic shows up here as a
// set difference, which is exactly how the V2.1 `Shield` gap went unnoticed.
//
// Not a vitest test on purpose — it needs the network and a published stream,
// while every test in this repo is hermetic.
//
// Usage:
//   node packages/producer/scripts/railgun-crosscheck.mjs \
//     --manifest https://storage.googleapis.com/pp-state/ \
//     --protocol railgun-1-smartwallet \
//     --from 14693013 --to 16077369
//
// Exits 0 when every set matches, 1 on any difference or error.

import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { HttpStore, Manifest, sha256Hex } from "@saga-sync/core";
import { decodeEventLog, parseAbiItem, toEventSelector, toEventSignature } from "viem";

const DEFAULT_MANIFEST = "https://storage.googleapis.com/pp-state/";
const DEFAULT_PROTOCOL = "railgun-1-smartwallet";
const DEFAULT_SQUID =
  "https://rail-squid.squids.live/squid-railgun-ethereum-v2/v/v1/graphql";
const SQUID_PAGE = 5000;

// Kohaku's `normalize_tree_position`: a leaf's identity is its *global* position,
// `treeNumber * LEAVES_PER_TREE + treePosition`, because the squid is allowed to
// emit an overflowing treePosition. Comparing on the global position makes both
// sides agree regardless of how they split it.
const LEAVES_PER_TREE = 65536n;

// The eight events RailgunSmartWallet has emitted across its V1 / V2.0 / V2.1
// lifetimes, with parameter names so decoded args are readable. Each is checked
// against publish-config.json below, so this list cannot silently drift from what
// the scraper is configured to fetch.
const EVENT_ABIS = [
  // --- V1 (pre-V2 proxy implementation) ---
  "event GeneratedCommitmentBatch(uint256 treeNumber, uint256 startPosition, (uint256 npk, (uint8 tokenType, address tokenAddress, uint256 tokenSubID) token, uint120 value)[] commitments, uint256[2][] encryptedRandom)",
  "event CommitmentBatch(uint256 treeNumber, uint256 startPosition, uint256[] hash, (uint256[4] ciphertext, uint256[2] ephemeralKeys, uint256[] memo)[] ciphertext)",
  "event Nullifiers(uint256 treeNumber, uint256[] nullifier)",
  // --- V2.0 ---
  "event Shield(uint256 treeNumber, uint256 startPosition, (bytes32 npk, (uint8 tokenType, address tokenAddress, uint256 tokenSubID) token, uint120 value)[] commitments, (bytes32[3] encryptedBundle, bytes32 shieldKey)[] shieldCiphertext)",
  // --- V2.1 (adds the `fees` array; the only Shield emitted since block 16790865) ---
  "event Shield(uint256 treeNumber, uint256 startPosition, (bytes32 npk, (uint8 tokenType, address tokenAddress, uint256 tokenSubID) token, uint120 value)[] commitments, (bytes32[3] encryptedBundle, bytes32 shieldKey)[] shieldCiphertext, uint256[] fees)",
  // --- V2 (unchanged across 2.0 / 2.1) ---
  "event Transact(uint256 treeNumber, uint256 startPosition, bytes32[] hash, (bytes32[4] ciphertext, bytes32 blindedSenderViewingKey, bytes32 blindedReceiverViewingKey, bytes annotationData, bytes memo)[] ciphertext)",
  "event Unshield(address to, (uint8 tokenType, address tokenAddress, uint256 tokenSubID) token, uint256 amount, uint256 fee)",
  "event Nullified(uint16 treeNumber, bytes32[] nullifier)",
].map((sig) => {
  const item = parseAbiItem(sig);
  return { item, topic: toEventSelector(item), signature: toEventSignature(item) };
});

const ABI_BY_TOPIC = new Map(EVENT_ABIS.map((e) => [e.topic, e]));

// --- helpers -----------------------------------------------------------------

const dec = (v) => BigInt(v).toString(); // bytes32 | uint | decimal string -> decimal
const bytes32 = (v) => `0x${BigInt(v).toString(16).padStart(64, "0")}`;
const lower = (s) => String(s).toLowerCase();

function parseArgs(argv) {
  const out = {
    manifest: DEFAULT_MANIFEST,
    protocol: DEFAULT_PROTOCOL,
    squid: DEFAULT_SQUID,
    config: "./publish-config.json",
    from: null,
    to: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const [flag, inline] = argv[i].split("=", 2);
    const value = () => inline ?? argv[++i];
    switch (flag) {
      case "--manifest": out.manifest = value(); break;
      case "--protocol": out.protocol = value(); break;
      case "--squid": out.squid = value(); break;
      case "--config": out.config = value(); break;
      case "--from": out.from = BigInt(value()); break;
      case "--to": out.to = BigInt(value()); break;
      case "--help": case "-h": usage(); process.exit(0);
      default: fail(`unknown flag: ${flag}`);
    }
  }
  if (out.from === null || out.to === null) fail("--from and --to are required");
  if (out.to <= out.from) fail("--to must be greater than --from (range is half-open)");
  return out;
}

function usage() {
  console.log(
    "usage: railgun-crosscheck.mjs --from <block> --to <block> " +
      "[--manifest <url>] [--protocol <id>] [--squid <url>] [--config <path>]\n" +
      "\nRange is half-open [from, to), matching the manifest's chunk convention.",
  );
}

function fail(msg) {
  console.error(`error: ${msg}`);
  process.exit(1);
}

// --- 1. guard: the ABIs here must match what the scraper is configured to fetch ---

function checkConfig(configPath, protocolId) {
  let cfg;
  try {
    cfg = JSON.parse(readFileSync(configPath, "utf8"));
  } catch (err) {
    fail(`cannot read ${configPath}: ${err.message}`);
  }
  const entry = cfg.protocols?.[protocolId];
  if (!entry) fail(`${configPath} has no protocol "${protocolId}"`);

  const configured = new Set(entry.events.map((e) => lower(e.eventTopic)));
  const known = new Set(EVENT_ABIS.map((e) => e.topic));
  const problems = [];

  for (const topic of known) {
    if (!configured.has(topic)) problems.push(`config does not scrape ${topic}`);
  }
  for (const topic of configured) {
    if (!known.has(topic)) problems.push(`config scrapes ${topic}, which this script cannot decode`);
  }
  // protocolMetadata.events is the stream's self-description; keep it honest.
  const declared = entry.protocolMetadata?.events ?? {};
  for (const { topic, signature } of EVENT_ABIS) {
    if (declared[topic] === undefined) {
      problems.push(`protocolMetadata.events is missing ${topic}`);
    } else if (declared[topic] !== signature) {
      problems.push(
        `protocolMetadata.events[${topic}] says "${declared[topic]}", canonical form is "${signature}"`,
      );
    }
  }

  if (problems.length > 0) {
    for (const p of problems) console.error(`  config: ${p}`);
    fail(`${problems.length} config/ABI mismatch(es) — fix these before trusting a comparison`);
  }
  console.log(`config: ${EVENT_ABIS.length} event topics agree with ${protocolId}`);
}

// --- 2. our side: read + verify chunks, decode into entity sets ---------------

async function readOurEvents({ manifest, protocol, from, to }) {
  const store = new HttpStore(manifest);
  const index = await Manifest.load(store);
  if (!index.protocolIds().includes(protocol)) {
    fail(`manifest at ${manifest} has no stream "${protocol}" (has: ${index.protocolIds().join(", ")})`);
  }
  const gaps = index.gaps(protocol);
  if (gaps.length > 0) {
    fail(`stream "${protocol}" has ${gaps.length} gap(s) in its sealed chunks: ${JSON.stringify(gaps)}`);
  }

  const metas = [...index.sealedChunks(protocol)];
  const hot = index.hotHead(protocol);
  if (hot) metas.push(hot);
  // Chunk ranges are half-open, so a chunk overlaps [from,to) iff it starts
  // before `to` and ends after `from`.
  const selected = metas.filter(
    (m) => BigInt(m.fromBlock) < to && BigInt(m.toBlock) > from,
  );
  if (selected.length === 0) fail(`no chunks cover [${from}, ${to})`);

  const events = [];
  for (const meta of selected) {
    const compressed = await store.get(meta.file);
    if (!compressed) fail(`chunk missing from store: ${meta.file}`);
    const raw = gunzipSync(compressed);
    const digest = sha256Hex(raw);
    if (digest !== meta.digest.data) {
      fail(`digest mismatch for ${meta.file}: manifest ${meta.digest.data}, computed ${digest}`);
    }
    for (const line of raw.toString("utf8").split("\n")) {
      if (line.length === 0) continue;
      const e = JSON.parse(line);
      const block = BigInt(e.blockNumber);
      if (block >= from && block < to) events.push(e);
    }
  }
  console.log(
    `stream:  ${selected.length} chunk(s) verified, ${events.length} log(s) in [${from}, ${to})`,
  );
  return events;
}

// A commitment's identity: global leaf position + the discriminant a consumer can
// actually derive from the log. For Transact / legacy CommitmentBatch the log
// carries the leaf `hash` directly. For Shield / legacy GeneratedCommitmentBatch
// it carries the preimage instead, and the hash is Poseidon-derived — kohaku
// recomputes it (`Shield::hash()`), so comparing on the preimage proves
// sufficiency without needing a Poseidon implementation here.
const commitmentKey = (pos, kind, discriminant) => `${pos}|${kind}|${discriminant}`;
const preimageKey = (npk, tokenAddress, value) =>
  `${dec(npk)}:${lower(tokenAddress)}:${dec(value)}`;

function decodeOurs(events) {
  const commitments = new Map();
  const nullifiers = new Map();
  const unshields = new Map();
  const undecodable = [];

  const addLeaf = (treeNumber, startPosition, i, kind, discriminant, ctx) => {
    const pos = BigInt(treeNumber) * LEAVES_PER_TREE + BigInt(startPosition) + BigInt(i);
    commitments.set(commitmentKey(pos, kind, discriminant), ctx);
  };

  for (const e of events) {
    const abi = ABI_BY_TOPIC.get(lower(e.eventTopic));
    if (!abi) {
      undecodable.push(e.eventTopic);
      continue;
    }
    let args;
    try {
      ({ args } = decodeEventLog({ abi: [abi.item], data: e.data, topics: e.topics }));
    } catch (err) {
      fail(`could not decode ${abi.item.name} at block ${e.blockNumber} log ${e.logIndex}: ${err.message}`);
    }
    const at = `block ${BigInt(e.blockNumber)} log ${BigInt(e.logIndex)}`;

    switch (abi.signature.split("(")[0]) {
      case "Shield":
        args.commitments.forEach((c, i) =>
          addLeaf(args.treeNumber, args.startPosition, i, "shield",
            preimageKey(c.npk, c.token.tokenAddress, c.value), at));
        break;
      case "GeneratedCommitmentBatch":
        args.commitments.forEach((c, i) =>
          addLeaf(args.treeNumber, args.startPosition, i, "legacy-generated",
            preimageKey(c.npk, c.token.tokenAddress, c.value), at));
        break;
      case "Transact":
        args.hash.forEach((h, i) =>
          addLeaf(args.treeNumber, args.startPosition, i, "transact", dec(h), at));
        break;
      case "CommitmentBatch":
        args.hash.forEach((h, i) =>
          addLeaf(args.treeNumber, args.startPosition, i, "legacy-encrypted", dec(h), at));
        break;
      case "Nullified":
      case "Nullifiers":
        for (const n of args.nullifier) {
          nullifiers.set(`${BigInt(args.treeNumber)}|${bytes32(n)}`, at);
        }
        break;
      case "Unshield":
        // The squid keys an unshield by (block, logIndex), which we have exactly.
        unshields.set(
          `${BigInt(e.blockNumber)}:${BigInt(e.logIndex)}|${lower(args.to)}|` +
            `${lower(args.token.tokenAddress)}|${dec(args.amount)}|${dec(args.fee)}`,
          at,
        );
        break;
    }
  }

  if (undecodable.length > 0) {
    const distinct = [...new Set(undecodable)];
    fail(
      `stream contains ${undecodable.length} log(s) with ${distinct.length} unknown topic(s): ` +
        `${distinct.join(", ")} — the ABI table above is incomplete`,
    );
  }
  return { commitments, nullifiers, unshields };
}

// --- 3. squid side -----------------------------------------------------------

async function squidQuery(endpoint, query, variables) {
  for (let attempt = 0; attempt < 3; attempt++) {
    let res;
    try {
      res = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query, variables }),
      });
    } catch (err) {
      if (attempt === 2) fail(`squid request failed: ${err.message}`);
      continue;
    }
    if (!res.ok) {
      if (attempt === 2) fail(`squid returned HTTP ${res.status}`);
      continue;
    }
    const body = await res.json();
    if (body.errors) fail(`squid errors: ${JSON.stringify(body.errors)}`);
    return body.data;
  }
}

// Keyset pagination on `id` — the squid's stable total order, and the same cursor
// kohaku uses. `blockNumber_lte` takes `to - 1` because our range is half-open.
async function squidPage(endpoint, field, selection, from, to) {
  const query = `query Q($id_gt: String, $gte: BigInt, $lte: BigInt, $limit: Int) {
  ${field}(orderBy: id_ASC, where: {id_gt: $id_gt, blockNumber_gte: $gte, blockNumber_lte: $lte}, limit: $limit) {
    id
    ${selection}
  }
}`;
  const rows = [];
  let cursor = "";
  for (;;) {
    const data = await squidQuery(endpoint, query, {
      id_gt: cursor,
      gte: from.toString(),
      lte: (to - 1n).toString(),
      limit: SQUID_PAGE,
    });
    const page = data[field];
    rows.push(...page);
    if (page.length < SQUID_PAGE) break;
    cursor = page[page.length - 1].id;
  }
  return rows;
}

const SQUID_KIND = {
  ShieldCommitment: "shield",
  TransactCommitment: "transact",
  LegacyGeneratedCommitment: "legacy-generated",
  LegacyEncryptedCommitment: "legacy-encrypted",
};

async function readSquid(endpoint, from, to) {
  const commitmentRows = await squidPage(
    endpoint,
    "commitments",
    `__typename blockNumber treeNumber treePosition hash
     ... on ShieldCommitment { preimage { npk value token { tokenAddress } } }
     ... on LegacyGeneratedCommitment { preimage { npk value token { tokenAddress } } }`,
    from,
    to,
  );
  const nullifierRows = await squidPage(
    endpoint, "nullifiers", "blockNumber treeNumber nullifier", from, to,
  );
  const unshieldRows = await squidPage(
    endpoint,
    "unshields",
    "blockNumber eventLogIndex to amount fee token { tokenAddress }",
    from,
    to,
  );

  const commitments = new Map();
  for (const r of commitmentRows) {
    const kind = SQUID_KIND[r.__typename];
    if (!kind) fail(`unexpected squid commitment type ${r.__typename}`);
    const pos = BigInt(r.treeNumber) * LEAVES_PER_TREE + BigInt(r.treePosition);
    const discriminant = r.preimage
      ? preimageKey(r.preimage.npk, r.preimage.token.tokenAddress, r.preimage.value)
      : dec(r.hash);
    commitments.set(commitmentKey(pos, kind, discriminant), `block ${r.blockNumber}`);
  }

  const nullifiers = new Map();
  for (const r of nullifierRows) {
    nullifiers.set(`${BigInt(r.treeNumber)}|${bytes32(r.nullifier)}`, `block ${r.blockNumber}`);
  }

  const unshields = new Map();
  for (const r of unshieldRows) {
    unshields.set(
      `${BigInt(r.blockNumber)}:${BigInt(r.eventLogIndex)}|${lower(r.to)}|` +
        `${lower(r.token.tokenAddress)}|${dec(r.amount)}|${dec(r.fee)}`,
      `block ${r.blockNumber}`,
    );
  }

  console.log(
    `squid:   ${commitmentRows.length} commitment(s), ${nullifierRows.length} nullifier(s), ` +
      `${unshieldRows.length} unshield(s)`,
  );
  return { commitments, nullifiers, unshields };
}

// --- 4. compare --------------------------------------------------------------

function diff(label, ours, theirs) {
  const missing = [...theirs.keys()].filter((k) => !ours.has(k)); // squid has, we don't
  const extra = [...ours.keys()].filter((k) => !theirs.has(k)); // we have, squid doesn't
  const ok = missing.length === 0 && extra.length === 0;
  console.log(
    `${ok ? "  OK  " : "  FAIL"} ${label.padEnd(12)} ours=${String(ours.size).padStart(7)} ` +
      `squid=${String(theirs.size).padStart(7)} missing=${missing.length} extra=${extra.length}`,
  );
  for (const k of missing.slice(0, 5)) console.log(`         missing: ${k}`);
  for (const k of extra.slice(0, 5)) console.log(`         extra:   ${k} (${ours.get(k)})`);
  if (missing.length > 5) console.log(`         … ${missing.length - 5} more missing`);
  if (extra.length > 5) console.log(`         … ${extra.length - 5} more extra`);
  return ok;
}

// Break the commitment comparison down per kind, so a whole-class outage (which
// is what a stale topic looks like) is obvious rather than buried in a total.
function byKind(map) {
  const out = new Map();
  for (const [k, v] of map) {
    const kind = k.split("|")[1];
    if (!out.has(kind)) out.set(kind, new Map());
    out.get(kind).set(k, v);
  }
  return out;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  console.log(`range:   [${opts.from}, ${opts.to})`);
  checkConfig(opts.config, opts.protocol);

  const ours = decodeOurs(await readOurEvents(opts));
  const theirs = await readSquid(opts.squid, opts.from, opts.to);

  console.log("\ncomparison:");
  const oursByKind = byKind(ours.commitments);
  const theirsByKind = byKind(theirs.commitments);
  const kinds = [...new Set([...oursByKind.keys(), ...theirsByKind.keys()])].sort();
  let ok = true;
  for (const kind of kinds) {
    ok = diff(kind, oursByKind.get(kind) ?? new Map(), theirsByKind.get(kind) ?? new Map()) && ok;
  }
  ok = diff("nullifiers", ours.nullifiers, theirs.nullifiers) && ok;
  ok = diff("unshields", ours.unshields, theirs.unshields) && ok;

  console.log(ok ? "\nPASS — every set matches the squid" : "\nFAIL — see differences above");
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
