import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { findProjectRoot } from "../config.ts";
import { emitResult, EXIT, table } from "../output.ts";
import type { CallRecord, RunHeader, RunSummary } from "../runtime/trace.ts";
import { fmtBytes, fmtMs } from "../runtime/trace.ts";

interface RunFile {
  id: string;
  path: string;
  header?: RunHeader;
  summary?: RunSummary;
  calls: CallRecord[];
}

export interface RunsOptions {
  label?: string;
  limit?: number;
  json?: boolean;
  jsonl?: boolean;
}

export async function runsListCommand(opts: RunsOptions): Promise<number> {
  const runs = loadRuns().filter((r) => !opts.label || r.header?.label === opts.label);
  const shown = runs.slice(0, opts.limit ?? 20);

  if (opts.json) {
    emitResult(shown.map(({ id, header, summary }) => ({ id, label: header?.label, script: header?.script, startedAt: header?.startedAt, ...pick(summary) })));
    return EXIT.OK;
  }
  if (shown.length === 0) {
    process.stderr.write("no runs yet\n");
    return EXIT.OK;
  }
  const rows = [["RUN", "LABEL", "SCRIPT", "CALLS", "TIME", "OUT", "EXIT", "REASON"]];
  for (const r of shown) {
    const s = r.summary;
    rows.push([
      r.id,
      r.header?.label ?? "",
      r.header?.script ?? "",
      s ? String(s.calls) : `${r.calls.length}+`,
      s ? fmtMs(s.ms) : "running?",
      s ? fmtBytes(s.outputBytes) : "",
      s ? String(s.exitCode) : "",
      s?.reason ?? "",
    ]);
  }
  process.stdout.write(table(rows, { maxWidth: [46, 16, 30, 6, 8, 9, 4, 18] }) + "\n");
  return EXIT.OK;
}

export async function runsShowCommand(prefix: string | undefined, opts: RunsOptions): Promise<number> {
  const runs = loadRuns();
  let matches: RunFile[];
  if (opts.label) matches = runs.filter((r) => r.header?.label === opts.label).slice(0, 1);
  else if (prefix) matches = runs.filter((r) => r.id.startsWith(prefix));
  else matches = runs.slice(0, 1);

  if (matches.length === 0) {
    process.stderr.write(`dcompose: no run matches ${prefix ? `prefix ${prefix}` : opts.label ? `label ${opts.label}` : "(none exist)"}\n`);
    return EXIT.CONFIG;
  }
  if (matches.length > 1 && prefix) {
    process.stderr.write(`dcompose: ${matches.length} runs match ${prefix}; be more specific:\n${matches.slice(0, 8).map((m) => `  ${m.id}`).join("\n")}\n`);
    return EXIT.CONFIG;
  }
  const r = matches[0]!;

  if (opts.jsonl) {
    for (const c of r.calls) process.stdout.write(JSON.stringify(c) + "\n");
    return EXIT.OK;
  }
  if (opts.json) {
    emitResult({ id: r.id, header: r.header, summary: r.summary, calls: r.calls });
    return EXIT.OK;
  }

  const h = r.header;
  const s = r.summary;
  process.stdout.write(`${r.id}${h?.label ? `  (${h.label})` : ""}\n`);
  if (h) process.stdout.write(`script ${h.script}  started ${h.startedAt}  cwd ${h.cwd}\n`);
  if (h?.argv?.length) process.stdout.write(`argv   ${h.argv.join(" ")}\n`);
  if (s) process.stdout.write(`${s.exitCode === 0 ? "ok" : `exit ${s.exitCode}${s.reason ? ` (${s.reason})` : ""}`} · ${fmtMs(s.ms)} · ${s.calls} calls · ${s.errors} errors · output ${fmtBytes(s.outputBytes)}\n`);
  else process.stdout.write("no summary line (still running or killed)\n");
  if (r.calls.length) {
    const rows = [["#", "T+", "TOOL", "ARGS", "TIME", "RESULT", "ERROR"]];
    const t0 = h ? Date.parse(h.startedAt) : Date.parse(r.calls[0]!.t);
    for (const c of r.calls) {
      rows.push([String(c.seq), fmtMs(Date.parse(c.t) - t0), `${c.server}.${c.tool}`, fmtBytes(c.argsBytes), fmtMs(c.ms), fmtBytes(c.resultBytes), c.error ?? ""]);
    }
    process.stdout.write("\n" + table(rows, { maxWidth: [5, 8, 44, 9, 8, 9, 60] }) + "\n");
  }
  return EXIT.OK;
}

function loadRuns(): RunFile[] {
  const dir = join(findProjectRoot(), ".dcompose", "runs");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => ({ f, mtime: statSync(join(dir, f)).mtimeMs }))
    .sort((a, b) => b.f.localeCompare(a.f)) // ids sort chronologically
    .map(({ f }) => parseRun(join(dir, f), f.replace(/\.jsonl$/, "")));
}

function parseRun(path: string, id: string): RunFile {
  const run: RunFile = { id, path, calls: [] };
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let o: { kind?: string } & Record<string, unknown>;
    try {
      o = JSON.parse(line);
    } catch {
      continue; // partial last line from a killed process
    }
    if (o.kind === "run") run.header = o as unknown as RunHeader;
    else if (o.kind === "call") run.calls.push(o as unknown as CallRecord);
    else if (o.kind === "summary") run.summary = o as unknown as RunSummary;
  }
  return run;
}

function pick(s: RunSummary | undefined) {
  return s ? { ms: s.ms, calls: s.calls, errors: s.errors, exitCode: s.exitCode, outputBytes: s.outputBytes, reason: s.reason } : {};
}
