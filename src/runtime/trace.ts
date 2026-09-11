import { mkdirSync, openSync, writeSync, closeSync } from "node:fs";
import { join } from "node:path";

export interface CallRecord {
  seq: number;
  t: string;
  server: string;
  tool: string;
  argsBytes: number;
  ms: number;
  resultBytes: number;
  error?: string;
}

export interface RunHeader {
  runId: string;
  label?: string;
  script: string;
  startedAt: string;
  cwd: string;
  argv: string[];
}

export interface RunSummary {
  runId: string;
  endedAt: string;
  ms: number;
  calls: number;
  errors: number;
  exitCode: number;
  outputBytes: number;
  reason?: string;
}

interface Agg {
  calls: number;
  ms: number;
  bytes: number;
  errors: number;
}

/**
 * Append-only NDJSON trace at `.dcompose/runs/<runId>.jsonl`.
 * Line 1 is `{kind:"run", ...header}`, then one `{kind:"call", ...}` per tool call,
 * last line `{kind:"summary", ...}`. Written synchronously so a killed process still leaves a usable file.
 */
export class RunTrace {
  readonly path: string;
  readonly header: RunHeader;
  private fd: number | null = null;
  private seq = 0;
  private errorCount = 0;
  private readonly agg = new Map<string, Agg>();
  private readonly startedMs = Date.now();

  constructor(runsDir: string, header: RunHeader) {
    mkdirSync(runsDir, { recursive: true });
    this.path = join(runsDir, `${header.runId}.jsonl`);
    this.header = header;
    this.fd = openSync(this.path, "a");
    this.write({ kind: "run", ...header });
  }

  get calls(): number {
    return this.seq;
  }

  get elapsedMs(): number {
    return Date.now() - this.startedMs;
  }

  record(r: Omit<CallRecord, "seq" | "t">): CallRecord {
    const rec: CallRecord = { seq: ++this.seq, t: new Date().toISOString(), ...r };
    this.write({ kind: "call", ...rec });
    const key = `${r.server}.${r.tool}`;
    const a = this.agg.get(key) ?? { calls: 0, ms: 0, bytes: 0, errors: 0 };
    a.calls++;
    a.ms += r.ms;
    a.bytes += r.resultBytes;
    if (r.error) {
      a.errors++;
      this.errorCount++;
    }
    this.agg.set(key, a);
    return rec;
  }

  finish(s: Omit<RunSummary, "runId" | "endedAt" | "ms" | "calls" | "errors">): RunSummary {
    const summary: RunSummary = {
      runId: this.header.runId,
      endedAt: new Date().toISOString(),
      ms: this.elapsedMs,
      calls: this.seq,
      errors: this.errorCount,
      ...s,
    };
    this.write({ kind: "summary", ...summary });
    if (this.fd !== null) {
      closeSync(this.fd);
      this.fd = null;
    }
    return summary;
  }

  /** Per-tool aggregate lines for the stderr summary. */
  aggregateLines(): string[] {
    const rows = [...this.agg.entries()].sort((a, b) => b[1].ms - a[1].ms);
    return rows.map(([key, a]) => {
      const err = a.errors ? `  ${a.errors} error${a.errors > 1 ? "s" : ""}` : "";
      return `${key.padEnd(40)} ${String(a.calls).padStart(5)} call${a.calls === 1 ? " " : "s"} ${fmtMs(a.ms).padStart(7)} ${fmtBytes(a.bytes).padStart(9)}${err}`;
    });
  }

  private write(obj: unknown): void {
    if (this.fd === null) return;
    writeSync(this.fd, JSON.stringify(obj) + "\n");
  }
}

export function fmtMs(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function byteLength(value: unknown): number {
  if (value === undefined) return 0;
  return Buffer.byteLength(typeof value === "string" ? value : JSON.stringify(value), "utf8");
}
