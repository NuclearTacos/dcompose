import { existsSync, writeFileSync } from "node:fs";
import { join, resolve, isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import type { Registry } from "./client.ts";
import { buildContext, GuardrailError, type Ctx } from "./runtime/context.ts";
import { RunTrace, byteLength, fmtBytes, fmtMs, type RunSummary } from "./runtime/trace.ts";
import { runId as makeRunId } from "./runtime/ulid.ts";
import { EXIT } from "./output.ts";

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
}

export interface RunOutcome {
  exitCode: number;
  /** Value to print on stdout, if any. */
  value?: unknown;
  summary: RunSummary;
  tracePath: string;
}

type ScriptFn = (ctx: Ctx) => Promise<unknown> | unknown;

export async function runScript(opts: RunOptions): Promise<RunOutcome> {
  const id = makeRunId();
  const runsDir = join(opts.projectRoot, ".dcompose", "runs");
  const trace = new RunTrace(runsDir, {
    runId: id,
    label: opts.label,
    script: opts.script ?? "<eval>",
    startedAt: new Date().toISOString(),
    cwd: process.cwd(),
    argv: process.argv.slice(2),
  });
  process.env.DCOMPOSE_RUN_ID = id;
  if (!opts.quiet) process.stderr.write(`[dcompose] run ${id}${opts.label ? ` (${opts.label})` : ""}\n`);

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
  });

  let exitCode: number = EXIT.OK;
  let value: unknown;
  let reason: string | undefined;
  let outputBytes = 0;

  try {
    const fn = opts.code !== undefined ? compileInline(opts.code) : await loadScript(opts.script!, opts.projectRoot);
    value = await withTimeout(Promise.resolve().then(() => fn(ctx)), opts.timeoutMs);
    outputBytes = byteLength(value);

    if (opts.maxOutputBytes > 0 && outputBytes > opts.maxOutputBytes) {
      const full = join(runsDir, `${id}.result.json`);
      writeFileSync(full, JSON.stringify(value, null, 2));
      const preview = JSON.stringify(value).slice(0, 512);
      value = { $dcompose: "output-truncated", bytes: outputBytes, limit: opts.maxOutputBytes, file: full, preview };
      exitCode = EXIT.GUARDRAIL;
      reason = "max-output-bytes";
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
  }

  const summary = trace.finish({ exitCode, outputBytes, reason });
  if (!opts.quiet) printSummary(trace, summary);
  return { exitCode, value, summary, tracePath: trace.path };
}

function makeAllow(allow?: string[], deny?: string[]): ((q: string) => boolean) | undefined {
  if (!allow?.length && !deny?.length) return undefined;
  const toRe = (g: string) => new RegExp("^" + g.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$");
  const allowRes = (allow ?? []).map(toRe);
  const denyRes = (deny ?? []).map(toRe);
  return (q) => {
    if (denyRes.some((r) => r.test(q))) return false;
    if (allowRes.length === 0) return true;
    return allowRes.some((r) => r.test(q));
  };
}

async function loadScript(script: string, projectRoot: string): Promise<ScriptFn> {
  const path = resolveScript(script, projectRoot);
  const mod = (await import(pathToFileURL(path).href)) as Record<string, unknown>;
  const fn = mod.default ?? mod.run ?? mod.main;
  if (typeof fn !== "function") {
    throw new Error(`${script}: expected \`export default async function (ctx) { ... }\` (or a named \`run\` export)`);
  }
  return fn as ScriptFn;
}

/** Accepts a path, or a bare name resolved under .dcompose/scripts/ with .ts/.js/.mjs. */
export function resolveScript(script: string, projectRoot: string): string {
  const direct = isAbsolute(script) ? script : resolve(process.cwd(), script);
  if (existsSync(direct)) return direct;
  const base = join(projectRoot, ".dcompose", "scripts", script);
  for (const p of [base, `${base}.ts`, `${base}.js`, `${base}.mjs`]) if (existsSync(p)) return p;
  throw new Error(`script not found: ${script} (looked in cwd and ${join(projectRoot, ".dcompose", "scripts")})`);
}

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (...a: string[]) => (...args: unknown[]) => Promise<unknown>;
const CTX_KEYS = ["mcp", "call", "input", "stdin", "pmap", "sleep", "emit", "log", "runId"];

/** `dcompose eval`: try as a single expression first, then as a function body. */
function compileInline(code: string): ScriptFn {
  const params = `{ ${CTX_KEYS.join(", ")} }`;
  let fn: (...args: unknown[]) => Promise<unknown>;
  try {
    fn = new AsyncFunction(params, `return (${code}\n);`);
  } catch {
    fn = new AsyncFunction(params, code);
  }
  return (ctx) => fn(ctx);
}

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

function printSummary(trace: RunTrace, s: RunSummary): void {
  const lines = trace.aggregateLines();
  for (const l of lines) process.stderr.write(`[dcompose] ${l}\n`);
  const status = s.exitCode === 0 ? "done" : `exit ${s.exitCode}${s.reason ? ` (${s.reason})` : ""}`;
  process.stderr.write(`[dcompose] ${status} in ${fmtMs(s.ms)} · ${s.calls} call${s.calls === 1 ? "" : "s"} · output ${fmtBytes(s.outputBytes)} · trace ${trace.path}\n`);
}
