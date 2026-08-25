import { readFileSync } from "node:fs";
import { z } from "zod";
import type { Hex } from "viem";

const address = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/, "expected a 20-byte (0x + 40 hex) address");
const topic = z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/, "expected a 32-byte (0x + 64 hex) topic");
const quantity = z
  .string()
  .regex(/^0x[0-9a-fA-F]+$/, "expected a 0x-prefixed hex quantity");

const eventFilterSchema = z.object({
  contractAddress: address,
  eventTopic: topic,
  filter: z.array(topic).optional(),
});

// `chunkSettings.maxSizeBytes` (optional, number or 0x-hex) tells the
// chunk-builder how big each chunk may grow. Other chunkSettings fields are
// ignored — passthrough is set so they don't cause a validation error.
const chunkSettingsSchema = z
  .object({
    maxSizeBytes: z.union([z.number().int().positive(), quantity]).optional(),
  })
  .passthrough()
  .optional();

// Where a stream's records come from. Defaults to "rpc" when absent, so every
// config written before sources existed stays valid and unchanged in meaning.
//
// "subsquid" mirrors a Squid GraphQL index. That is a deliberate downgrade in
// provenance — the bytes are reproducible only against that third-party index,
// not against the chain — so it is opt-in per stream and recorded in the
// manifest's protocolMetadata, never inferred.
const sourceSchema = z
  .discriminatedUnion("kind", [
    z.object({ kind: z.literal("rpc") }),
    z.object({
      kind: z.literal("subsquid"),
      endpoint: z.string().url("expected an absolute http(s) URL"),
      // Which entity to mirror. Only "railgun-operation" exists today; naming it
      // in config keeps the source from hardcoding one protocol's shape.
      entity: z.string().min(1),
    }),
  ])
  .optional();

const targetSchema = z.object({
  chainId: quantity,
  fromBlock: quantity,
  // Required for an rpc source, forbidden for the others — enforced below, since
  // zod cannot express "depends on a sibling field" in the shape alone.
  events: z.array(eventFilterSchema).optional(),
  source: sourceSchema,
  chunkSettings: chunkSettingsSchema,
  // Descriptive metadata surfaced in the manifest (all optional). `protocol` is
  // the family name (e.g. "tornado-cash"); `protocolMetadata` is a free-form
  // passthrough copied verbatim into the manifest — a blank slate for
  // protocol-specific fields. See the manifest's write-once immutability note.
  protocol: z.string().optional(),
  protocolMetadata: z.record(z.unknown()).optional(),
}).superRefine((t, ctx) => {
  const kind = t.source?.kind ?? "rpc";
  if (kind === "rpc" && (t.events === undefined || t.events.length === 0)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["events"],
      message: "at least one event filter is required for an rpc source",
    });
  }
  if (kind !== "rpc" && t.events !== undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["events"],
      message: `events are only meaningful for an rpc source (this stream's source is "${kind}")`,
    });
  }
});

export type EventFilter = {
  contractAddress: Hex;
  eventTopic: Hex;
  filter?: Hex[];
};

// Where a stream's records come from. Always resolved (never undefined) so
// callers never have to re-apply the "absent means rpc" default.
export type SourceConfig =
  | { kind: "rpc" }
  | { kind: "subsquid"; endpoint: string; entity: string };

export type ScraperTarget = {
  chainId: Hex;
  fromBlock: Hex;
  source: SourceConfig;
  // Present only for an rpc source; the schema rejects them for any other kind.
  events?: EventFilter[];
  // Resolved from chunkSettings.maxSizeBytes if present. Orchestrator passes
  // it through to the chunk-builder; the scraper itself doesn't use it.
  maxSizeBytes?: number;
  // Manifest metadata (config-carried). `trackedAddresses`/`trackedEventTopics`
  // are derived from the unique `events[].contractAddress`/`.eventTopic` in
  // config order, so a stream with no event filters advertises neither. The
  // client already treats both as optional.
  protocol?: string;
  protocolMetadata?: Record<string, unknown>;
  trackedAddresses?: Hex[];
  trackedEventTopics?: Hex[];
};

function readAndParse(path: string): Record<string, unknown> {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new Error(`config ${path}: ${(err as Error).message}`);
  }
  const protocols = (raw as { protocols?: Record<string, unknown> } | null)?.protocols;
  if (!protocols || typeof protocols !== "object") {
    throw new Error(`config ${path}: missing top-level "protocols" object`);
  }
  return protocols;
}

function parseTarget(path: string, protocolId: string, raw: unknown): ScraperTarget {
  const parsed = targetSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${["protocols", protocolId, ...i.path].join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`config ${path} is invalid:\n${issues}`);
  }
  const maxSizeRaw = parsed.data.chunkSettings?.maxSizeBytes;
  const maxSizeBytes =
    maxSizeRaw === undefined
      ? undefined
      : typeof maxSizeRaw === "number"
        ? maxSizeRaw
        : Number(BigInt(maxSizeRaw));
  const events = parsed.data.events as EventFilter[] | undefined;
  const target: ScraperTarget = {
    chainId: parsed.data.chainId as Hex,
    fromBlock: parsed.data.fromBlock as Hex,
    source: (parsed.data.source ?? { kind: "rpc" }) as SourceConfig,
  };
  if (events !== undefined) {
    target.events = events;
    // Unique tracked contract addresses / event topics, in config (first-seen) order.
    target.trackedAddresses = [...new Set(events.map((e) => e.contractAddress))] as Hex[];
    target.trackedEventTopics = [...new Set(events.map((e) => e.eventTopic))] as Hex[];
  }
  if (maxSizeBytes !== undefined) target.maxSizeBytes = maxSizeBytes;
  if (parsed.data.protocol !== undefined) target.protocol = parsed.data.protocol;
  if (parsed.data.protocolMetadata !== undefined) {
    target.protocolMetadata = parsed.data.protocolMetadata;
  }
  return target;
}

export function loadConfig(path: string, protocolId: string): ScraperTarget {
  const protocols = readAndParse(path);
  if (!(protocolId in protocols)) {
    const known = Object.keys(protocols).join(", ") || "(none)";
    throw new Error(`config ${path}: no protocol "${protocolId}". Known: ${known}`);
  }
  return parseTarget(path, protocolId, protocols[protocolId]);
}

// Orchestrator-side: load every protocol at once. Each is validated independently
// so a single bad protocol entry doesn't poison the dict.
export function loadAllProtocols(path: string): Record<string, ScraperTarget> {
  const protocols = readAndParse(path);
  const out: Record<string, ScraperTarget> = {};
  for (const [id, raw] of Object.entries(protocols)) {
    out[id] = parseTarget(path, id, raw);
  }
  return out;
}
