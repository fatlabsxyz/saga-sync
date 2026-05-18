import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config.js";

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
});
