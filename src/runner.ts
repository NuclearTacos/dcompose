import { writeFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import type { Registry } from "./client.ts";
import { buildContext, GuardrailError } from "./runtime/context.ts";
import { netRestricted, startIsolated, type IsolatedRun } from "./runtime/isolate.ts";
import { compileInline, isAsyncIterable, loadModule, resolveScript, type ScriptFn } from "./runtime/load.ts";
import { openStore } from "./runtime/store.ts";
import { RunTrace, byteLength, fmtBytes, fmtMs, type RunSummary } from "./runtime/trace.ts";
import { runId as makeRunId } from "./runtime/ulid.ts";
import { EXIT, type OutputOptions } from "./output.ts";

export interface RunOptions {
  projectRoot: string;
  registry: Registry;
  /** Path to a script module, or undefined when `code` is given. */
  script?: string;
  /** Inline body for `dcompose eval`. */
  code?: string;
  input: unknown;
  label?: string;
  timeoutMs: number; // 0 = none
  maxCalls: number; // 0 = unlimited
  maxOutputBytes: number;
  concurrency: number;
  callTimeoutMs?: number;
  allow?: string[];
  deny?: string[];
  readOnly?: boolean;
  dryRun?: boolean;
  quiet?: boolean;
  allowExec?: boolean;
  /** Store name; defaults to the script's base name (or "_eval"). */
  stateName?: string;
  /** How to print streamed items (async-generator scripts). */
  output?: OutputOptions;
  /** Stream each call record to stderr as NDJSON while the script runs. */
  trace?: boolean;
  /** Run the script in a child process under Node's permission model; MCP calls are proxied back. */
  isolate?: boolean;
}

export interface RunOutcome {
  exitCode: number;
  /** Value to print on stdout, if any. Undefined for streamed runs (already printed). */
  value?: unknown;
  summary: RunSummary;
  tracePath: string;
  streamed: number;
}

export async function runScript(opts: RunOptions): Promise<RunOutcome> {
  const id = makeRunId();
  const runsDir = join(opts.projectRoot, ".dcompose", "runs");
  const trace = new RunTrace(
    runsDir,
    {
      runId: id,
      label: opts.label,
      script: opts.script ?? "<eval>",
      startedAt: new Date().toISOString(),
      cwd: process.cwd(),
      argv: process.argv.slice(2),
    },
    {
      onRecord: opts.trace ? (rec) => process.stderr.write(JSON.stringify({ kind: "call", ...rec }) + "\n") : undefined,
    },
  );
  process.env.DCOMPOSE_RUN_ID = id;
  if (!opts.quiet) {
    // Echo the resolved script path: bare names resolve under a workspace dir nobody can guess.
    const where = opts.script ? ` · script ${safeResolve(opts.script, opts.projectRoot)}` : "";
    const iso = opts.isolate ? (netRestricted() ? " · isolated" : " · isolated (network open on this Node)") : "";
    process.stderr.write(`[dcompose] run ${id}${opts.label ? ` (${opts.label})` : ""}${where}${iso}\n`);
  }
  if (opts.isolate && opts.allowExec) process.stderr.write("[dcompose] --allow-exec is ignored under --isolate\n");

  const stateName = opts.stateName ?? (opts.script ? basename(opts.script, extname(opts.script)) : "_eval");
  const ctx = buildContext({
    registry: opts.registry,
    trace,
    input: opts.input,
    maxCalls: opts.maxCalls,
    defaultConcurrency: opts.concurrency,
    callTimeoutMs: opts.callTimeoutMs,
    allow: makeAllow(opts.allow, opts.deny),
    readOnly: opts.readOnly,
    dryRun: opts.dryRun,
    store: openStore(join(opts.projectRoot, ".dcompose", "state"), stateName),
    allowExec: opts.allowExec && !opts.isolate,
  });

  let exitCode: number = EXIT.OK;
  let isolated: IsolatedRun | undefined;
  let value: unknown;
  let reason: string | undefined;
  let outputBytes = 0;
  let streamed = 0;

  try {
    let result: unknown;
    if (opts.isolate) {
      isolated = startIsolated({
        ctx,
        script: opts.script ? resolveScript(opts.script, opts.projectRoot) : undefined,
        code: opts.code,
        projectRoot: opts.projectRoot,
        servers: opts.registry.names(),
        concurrency: opts.concurrency,
      });
      result = await withTimeout(isolated.result, opts.timeoutMs);
    } else {
      const fn = opts.code !== undefined ? compileInline(opts.code) : await loadScript(opts.script!, opts.projectRoot);
      result = await withTimeout(
        Promise.resolve().then(() => fn(ctx)),
        opts.timeoutMs,
      );
    }

    if (isAsyncIterable(result)) {
      // Streaming script: each yielded item is one NDJSON line on stdout, flushed as it arrives.
      // The overall --timeout covers the whole iteration.
      await withTimeout(
        (async () => {
          for await (const item of result) {
            const bytes = byteLength(item);
            if (opts.maxOutputBytes > 0 && bytes > opts.maxOutputBytes) {
              throw new GuardrailError(
                "max-output-bytes",
                `streamed item #${streamed + 1} is ${fmtBytes(bytes)}, over --max-output-bytes (${fmtBytes(opts.maxOutputBytes)})`,
              );
            }
            const raw = opts.output?.raw && typeof item === "string";
            process.stdout.write((raw ? (item as string) : JSON.stringify(item)) + "\n");
            streamed++;
            outputBytes += bytes;
          }
        })(),
        opts.timeoutMs,
      );
    } else {
      value = result;
      outputBytes = byteLength(value);
      if (opts.maxOutputBytes > 0 && outputBytes > opts.maxOutputBytes) {
        const full = join(runsDir, `${id}.result.json`);
        writeFileSync(full, JSON.stringify(value, null, 2));
        const preview = JSON.stringify(value).slice(0, 512);
        value = { $dcompose: "output-truncated", bytes: outputBytes, limit: opts.maxOutputBytes, file: full, preview };
        exitCode = EXIT.GUARDRAIL;
        reason = "max-output-bytes";
      }
    }
  } catch (e) {
    if (e instanceof GuardrailError || (e as Error).name === "TimeoutError") {
      exitCode = EXIT.GUARDRAIL;
      reason = e instanceof GuardrailError ? e.reason : "timeout";
    } else {
      exitCode = EXIT.SCRIPT_ERROR;
      reason = "script-error";
    }
    process.stderr.write(`dcompose: ${formatError(e)}\n`);
  } finally {
    isolated?.kill();
  }

  const summary = trace.finish({ exitCode, outputBytes, reason });
  if (!opts.quiet) printSummary(trace, summary, streamed);
  return { exitCode, value, summary, tracePath: trace.path, streamed };
}

export function makeAllow(allow?: string[], deny?: string[]): ((q: string) => boolean) | undefined {
  if (!allow?.length && !deny?.length) return undefined;
  const toRe = (g: string) =>
    new RegExp(
      "^" +
        g
          .split("*")
          .map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
          .join(".*") +
        "$",
    );
  const allowRes = (allow ?? []).map(toRe);
  const denyRes = (deny ?? []).map(toRe);
  return (q) => {
    if (denyRes.some((r) => r.test(q))) return false;
    if (allowRes.length === 0) return true;
    return allowRes.some((r) => r.test(q));
  };
}

function loadScript(script: string, projectRoot: string): Promise<ScriptFn> {
  return loadModule(resolveScript(script, projectRoot), script);
}

export { resolveScript };

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  if (ms <= 0) return p;
  return new Promise<T>((res, rej) => {
    const t = setTimeout(() => {
      const e = new Error(`script exceeded --timeout (${fmtMs(ms)})`);
      e.name = "TimeoutError";
      rej(e);
    }, ms);
    p.then(
      (v) => (clearTimeout(t), res(v)),
      (e) => (clearTimeout(t), rej(e)),
    );
  });
}

function formatError(e: unknown): string {
  if (!(e instanceof Error)) return String(e);
  // Expected failures: message only. Unexpected ones: message plus frames from the user's script.
  const quiet = ["GuardrailError", "TimeoutError", "ToolError", "ConnectionError"];
  if (quiet.includes(e.name)) return e.message;
  const frames = (e.stack ?? "")
    .split("\n")
    .slice(1)
    .filter((l) => !/node:internal|node_modules|[\\/]dcompose[\\/](src|dist)[\\/]/.test(l))
    .slice(0, 5);
  return [`${e.name}: ${e.message}`, ...frames].join("\n");
}

function printSummary(trace: RunTrace, s: RunSummary, streamed: number): void {
  const lines = trace.aggregateLines();
  for (const l of lines) process.stderr.write(`[dcompose] ${l}\n`);
  const status = s.exitCode === 0 ? "done" : `exit ${s.exitCode}${s.reason ? ` (${s.reason})` : ""}`;
  const out = streamed
    ? `streamed ${streamed} item${streamed === 1 ? "" : "s"} (${fmtBytes(s.outputBytes)})`
    : `output ${fmtBytes(s.outputBytes)}`;
  process.stderr.write(
    `[dcompose] ${status} in ${fmtMs(s.ms)} · ${s.calls} call${s.calls === 1 ? "" : "s"} · ${out} · trace ${trace.path}\n`,
  );
}

/** resolveScript for logging: never throw from the header line; the real resolve happens in loadScript. */
function safeResolve(script: string, projectRoot: string): string {
  try {
    return resolveScript(script, projectRoot);
  } catch {
    return script;
  }
}
