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

// Only the fields the scraper actually uses are validated. `chunkSettings`,
// `storeSettings`, `cronString` belong to the chunk builder / orchestrator and
// are ignored here — zod strips unknown keys by default.
const targetSchema = z.object({
  fromBlock: quantity,
  events: z.array(eventFilterSchema).min(1, "at least one event filter is required"),
});

export type EventFilter = {
  contractAddress: Hex;
  eventTopic: Hex;
  filter?: Hex[];
};

export type ScraperTarget = {
  fromBlock: Hex;
  events: EventFilter[];
};

export function loadConfig(path: string, protocolId: string): ScraperTarget {
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

  if (!(protocolId in protocols)) {
    const known = Object.keys(protocols).join(", ") || "(none)";
    throw new Error(`config ${path}: no protocol "${protocolId}". Known: ${known}`);
  }

  const parsed = targetSchema.safeParse(protocols[protocolId]);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${["protocols", protocolId, ...i.path].join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`config ${path} is invalid:\n${issues}`);
  }

  // zod validated the runtime shape; brand the hex strings for downstream typing.
  return parsed.data as unknown as ScraperTarget;
}
