import { readFileSync } from "node:fs";
import type { Registry } from "../client.ts";
import { findProjectRoot, parseDuration, type Config } from "../config.ts";
import { emitResult, type OutputOptions } from "../output.ts";
import { runScript } from "../runner.ts";

export interface RunCliOptions extends OutputOptions {
  input?: string;
  inputFile?: string;
  label?: string;
  timeout?: string;
  maxCalls?: number;
  maxOutputBytes?: string;
  concurrency?: number;
  callTimeout?: string;
  allow?: string;
  deny?: string;
  readOnly?: boolean;
  dryRun?: boolean;
  quiet?: boolean;
  rawOutput?: boolean;
  allowExec?: boolean;
  state?: string;
}

export async function runCommand(
  registry: Registry,
  config: Config,
  target: { script?: string; code?: string },
  opts: RunCliOptions,
): Promise<number> {
  const input = readInput(opts.input, opts.inputFile);
  const projectRoot = findProjectRoot();

  const outcome = await runScript({
    projectRoot,
    registry,
    script: target.script,
    code: target.code,
    input,
    label: opts.label,
    timeoutMs: parseDuration(opts.timeout ?? config.defaults.timeout),
    maxCalls: opts.maxCalls ?? config.defaults.maxCalls,
    maxOutputBytes: parseBytes(opts.maxOutputBytes ?? "64k"),
    concurrency: opts.concurrency ?? config.defaults.concurrency,
    callTimeoutMs: opts.callTimeout ? parseDuration(opts.callTimeout) : undefined,
    allow: splitList(opts.allow),
    deny: splitList(opts.deny),
    readOnly: opts.readOnly,
    dryRun: opts.dryRun,
    quiet: opts.quiet,
    allowExec: opts.allowExec,
    stateName: opts.state,
    output: { raw: opts.rawOutput },
  });

  if (outcome.streamed === 0 && outcome.value !== undefined) {
    emitResult(outcome.value, { pretty: opts.pretty, compact: opts.compact, jsonl: opts.jsonl, raw: opts.rawOutput });
  }
  return outcome.exitCode;
}

function readInput(inline: string | undefined, file: string | undefined): unknown {
  let text: string | undefined;
  if (file) text = file === "-" ? readFileSync(0, "utf8") : readFileSync(file, "utf8");
  else if (inline === "-") text = readFileSync(0, "utf8");
  else text = inline;
  if (text === undefined || text.trim() === "") return {};
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`--input is not valid JSON: ${(e as Error).message}`);
  }
}

function splitList(s: string | undefined): string[] | undefined {
  if (!s) return undefined;
  return s
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}

/** "64k", "1m", "512", "0" (unlimited). */
export function parseBytes(s: string): number {
  const m = /^(\d+(?:\.\d+)?)\s*([kmg]?)b?$/i.exec(s.trim());
  if (!m) throw new Error(`invalid byte size: ${s}`);
  const n = Number(m[1]);
  const mult = { "": 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3 }[m[2]!.toLowerCase() as "" | "k" | "m" | "g"];
  return Math.floor(n * mult);
}
