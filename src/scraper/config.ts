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

const targetSchema = z.object({
  chainId: quantity,
  fromBlock: quantity,
  events: z.array(eventFilterSchema).min(1, "at least one event filter is required"),
  chunkSettings: chunkSettingsSchema,
});

export type EventFilter = {
  contractAddress: Hex;
  eventTopic: Hex;
  filter?: Hex[];
};

export type ScraperTarget = {
  chainId: Hex;
  fromBlock: Hex;
  events: EventFilter[];
  // Resolved from chunkSettings.maxSizeBytes if present. Orchestrator passes
  // it through to the chunk-builder; the scraper itself doesn't use it.
  maxSizeBytes?: number;
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
  const target: ScraperTarget = {
    chainId: parsed.data.chainId as Hex,
    fromBlock: parsed.data.fromBlock as Hex,
    events: parsed.data.events as EventFilter[],
  };
  if (maxSizeBytes !== undefined) target.maxSizeBytes = maxSizeBytes;
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
