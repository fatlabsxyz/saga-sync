import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

// Walk the transitive relative-import graph from the browser library entry and
// collect any *value* (non-type) `node:` imports. Type-only imports are erased
// at build time, so they're harmless; value imports of node built-ins would
// break a browser bundle. Bare specifiers (@noble/*, viem) are assumed
// browser-safe and not walked.
function nodeValueImports(entry: string): string[] {
  const seen = new Set<string>();
  const offenders: string[] = [];
  const re = /(?:import|export)\s+(type\s+)?[^;]*?from\s+["']([^"']+)["']/g;

  const visit = (file: string): void => {
    if (seen.has(file)) return;
    seen.add(file);
    let src: string;
    try {
      src = readFileSync(file, "utf8");
    } catch {
      return;
    }
    for (const m of src.matchAll(re)) {
      const isType = Boolean(m[1]);
      const spec = m[2]!;
      if (spec.startsWith("node:")) {
        if (!isType) offenders.push(`${file.replace(here, "src")} → ${spec}`);
      } else if (spec.startsWith(".")) {
        visit(resolve(dirname(file), spec.replace(/\.js$/, ".ts")));
      }
    }
  };

  visit(entry);
  return offenders;
}

describe("browser library entry (src/index.ts)", () => {
  it("pulls no node: built-ins anywhere in its transitive graph", () => {
    expect(nodeValueImports(resolve(here, "index.ts"))).toEqual([]);
  });
});
