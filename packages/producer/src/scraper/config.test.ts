import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, loadAllProtocols } from "./config.js";

const validConfig = () => ({
  protocols: {
    "p-1-x": {
      chainId: "0x1",
      fromBlock: "0x10",
      cronString: "* * * * *",
      chunkSettings: { criteria: "block", criteriaSettings: "maxBlockRange" },
      storeSettings: { fileNameTemplate: "x", protocol: "disk", protocolSettings: {} },
      events: [
        {
          contractAddress: `0x${"a".repeat(40)}`,
          eventTopic: `0x${"b".repeat(64)}`,
        },
      ],
    },
  },
});

describe("loadConfig", () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "config-test-"));
    path = join(dir, "config.json");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const write = (obj: unknown) => writeFileSync(path, JSON.stringify(obj), "utf8");

  it("loads a valid target and drops chunk/store/cron fields it does not use", () => {
    write(validConfig());
    const target = loadConfig(path, "p-1-x");
    expect(target.chainId).toBe("0x1");
    expect(target.fromBlock).toBe("0x10");
    expect(target.events).toHaveLength(1);
    expect(target).not.toHaveProperty("chunkSettings");
    expect(target).not.toHaveProperty("storeSettings");
    expect(target).not.toHaveProperty("cronString");
  });

  it("keeps an optional indexed-topic filter when present", () => {
    const cfg: any = validConfig();
    cfg.protocols["p-1-x"].events[0].filter = [`0x${"c".repeat(64)}`];
    write(cfg);
    expect(loadConfig(path, "p-1-x").events[0].filter).toEqual([`0x${"c".repeat(64)}`]);
  });

  it("carries protocol + protocolMetadata and derives unique trackedAddresses", () => {
    const addrA = `0x${"a".repeat(40)}`;
    const addrB = `0x${"e".repeat(40)}`;
    const cfg: any = validConfig();
    cfg.protocols["p-1-x"].protocol = "tornado-cash";
    cfg.protocols["p-1-x"].protocolMetadata = { denomination: "100", asset: "ETH" };
    // Two events on addrA (same address) + one on addrB → deduped, config order.
    cfg.protocols["p-1-x"].events = [
      { contractAddress: addrA, eventTopic: `0x${"b".repeat(64)}` },
      { contractAddress: addrA, eventTopic: `0x${"c".repeat(64)}` },
      { contractAddress: addrB, eventTopic: `0x${"b".repeat(64)}` },
    ];
    write(cfg);
    const t = loadConfig(path, "p-1-x");
    expect(t.protocol).toBe("tornado-cash");
    expect(t.protocolMetadata).toEqual({ denomination: "100", asset: "ETH" });
    expect(t.trackedAddresses).toEqual([addrA, addrB]);
    // topics b (twice) + c → deduped, config order.
    expect(t.trackedEventTopics).toEqual([`0x${"b".repeat(64)}`, `0x${"c".repeat(64)}`]);
  });

  it("omits protocol/protocolMetadata when absent but always derives tracked sets", () => {
    write(validConfig());
    const t = loadConfig(path, "p-1-x");
    expect(t.protocol).toBeUndefined();
    expect(t.protocolMetadata).toBeUndefined();
    expect(t.trackedAddresses).toEqual([`0x${"a".repeat(40)}`]);
    expect(t.trackedEventTopics).toEqual([`0x${"b".repeat(64)}`]);
  });

  it("throws when fromBlock is missing", () => {
    const cfg: any = validConfig();
    delete cfg.protocols["p-1-x"].fromBlock;
    write(cfg);
    expect(() => loadConfig(path, "p-1-x")).toThrow(/fromBlock/);
  });

  it("throws when chainId is missing", () => {
    const cfg: any = validConfig();
    delete cfg.protocols["p-1-x"].chainId;
    write(cfg);
    expect(() => loadConfig(path, "p-1-x")).toThrow(/chainId/);
  });

  it("throws when events is empty", () => {
    const cfg: any = validConfig();
    cfg.protocols["p-1-x"].events = [];
    write(cfg);
    expect(() => loadConfig(path, "p-1-x")).toThrow(/at least one event/);
  });

  it("throws on a malformed contract address", () => {
    const cfg: any = validConfig();
    cfg.protocols["p-1-x"].events[0].contractAddress = "0xnothex";
    write(cfg);
    expect(() => loadConfig(path, "p-1-x")).toThrow(/address/);
  });

  it("throws with the known ids when the protocol id is not found", () => {
    write(validConfig());
    expect(() => loadConfig(path, "does-not-exist")).toThrow(/p-1-x/);
  });

  it("extracts chunkSettings.maxSizeBytes as a number when present", () => {
    const cfg: any = validConfig();
    cfg.protocols["p-1-x"].chunkSettings.maxSizeBytes = 1048576;
    write(cfg);
    expect(loadConfig(path, "p-1-x").maxSizeBytes).toBe(1048576);
  });

  it("extracts chunkSettings.maxSizeBytes as hex string", () => {
    const cfg: any = validConfig();
    cfg.protocols["p-1-x"].chunkSettings.maxSizeBytes = "0x100000";
    write(cfg);
    expect(loadConfig(path, "p-1-x").maxSizeBytes).toBe(0x100000);
  });

  it("omits maxSizeBytes when chunkSettings.maxSizeBytes is absent", () => {
    write(validConfig());
    expect(loadConfig(path, "p-1-x").maxSizeBytes).toBeUndefined();
  });
});

describe("loadAllProtocols", () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "config-test-"));
    path = join(dir, "config.json");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const write = (obj: unknown) => writeFileSync(path, JSON.stringify(obj), "utf8");

  it("returns every protocol in the file", () => {
    write({
      protocols: {
        "p-a": {
          chainId: "0x1",
          fromBlock: "0x10",
          events: [{ contractAddress: `0x${"a".repeat(40)}`, eventTopic: `0x${"b".repeat(64)}` }],
        },
        "p-b": {
          chainId: "0x89",
          fromBlock: "0x20",
          events: [{ contractAddress: `0x${"c".repeat(40)}`, eventTopic: `0x${"d".repeat(64)}` }],
        },
      },
    });
    const all = loadAllProtocols(path);
    expect(Object.keys(all).sort()).toEqual(["p-a", "p-b"]);
    expect(all["p-a"]?.chainId).toBe("0x1");
    expect(all["p-b"]?.chainId).toBe("0x89");
  });

  it("propagates a per-protocol validation error with the bad protocol id in the message", () => {
    write({
      protocols: {
        "p-a": {
          chainId: "0x1",
          fromBlock: "0x10",
          events: [{ contractAddress: `0x${"a".repeat(40)}`, eventTopic: `0x${"b".repeat(64)}` }],
        },
        "p-broken": {
          chainId: "0x1",
          // no fromBlock
          events: [{ contractAddress: `0x${"a".repeat(40)}`, eventTopic: `0x${"b".repeat(64)}` }],
        },
      },
    });
    expect(() => loadAllProtocols(path)).toThrow(/p-broken/);
  });
});
