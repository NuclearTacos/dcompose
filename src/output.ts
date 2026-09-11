/** stdout is data; stderr is everything else. */

export const EXIT = {
  OK: 0,
  SCRIPT_ERROR: 1,
  GUARDRAIL: 2,
  CONFIG: 3,
} as const;

export interface OutputOptions {
  pretty?: boolean;
  compact?: boolean;
  jsonl?: boolean;
  raw?: boolean;
}

export function emitResult(value: unknown, opts: OutputOptions = {}): void {
  const pretty = opts.pretty ?? (!opts.compact && process.stdout.isTTY === true);

  if (opts.jsonl && Array.isArray(value)) {
    for (const item of value) process.stdout.write(line(item, opts.raw) + "\n");
    return;
  }
  process.stdout.write(opts.raw && typeof value === "string" ? value + "\n" : JSON.stringify(value, null, pretty ? 2 : 0) + "\n");
}

function line(item: unknown, raw?: boolean): string {
  return raw && typeof item === "string" ? item : JSON.stringify(item);
}

export function log(...parts: unknown[]): void {
  process.stderr.write(parts.map((p) => (typeof p === "string" ? p : JSON.stringify(p))).join(" ") + "\n");
}

export function fail(message: string, code: number): never {
  process.stderr.write(`dcompose: ${message}\n`);
  process.exit(code);
}

/** Left-aligned columns, widths from content, capped per column. */
export function table(rows: string[][], opts: { maxWidth?: number[] } = {}): string {
  if (rows.length === 0) return "";
  const cols = Math.max(...rows.map((r) => r.length));
  const widths = Array.from({ length: cols }, (_, c) => {
    const w = Math.max(...rows.map((r) => (r[c] ?? "").length));
    const cap = opts.maxWidth?.[c];
    return cap ? Math.min(w, cap) : w;
  });
  return rows
    .map((r) =>
      r
        .map((cell, c) => {
          const w = widths[c]!;
          const s = cell.length > w ? cell.slice(0, Math.max(0, w - 1)) + "…" : cell;
          return c === r.length - 1 ? s : s.padEnd(w);
        })
        .join("  ")
        .trimEnd(),
    )
    .join("\n");
}

export function firstLine(s: string | undefined): string {
  return (s ?? "").split(/\r?\n/)[0]!.trim();
}
