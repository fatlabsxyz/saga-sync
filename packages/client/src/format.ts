// Human-readable byte size from a raw count. Binary units (KiB/MiB) to match how
// chunk sizes are reasoned about elsewhere. Exact byte counts stay in --json.
export function humanBytes(n: bigint): string {
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let v = Number(n);
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  return u === 0 ? `${v} B` : `${v.toFixed(1)} ${units[u]}`;
}

// Minimal fixed-width text table: a header row, a dashed rule, then the rows.
// Columns are sized to their widest cell. No dependency, no alignment beyond
// left-pad. `rows` may be empty (header + rule only).
export function table(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)),
  );
  const fmt = (cells: string[]): string =>
    cells.map((c, i) => c.padEnd(widths[i]!)).join("  ");
  const rule = widths.map((w) => "-".repeat(w)).join("  ");
  return [fmt(headers), rule, ...rows.map(fmt)].join("\n");
}
