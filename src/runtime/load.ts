import { existsSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { Ctx } from "./context.ts";

export type ScriptFn = (ctx: Ctx) => Promise<unknown> | unknown | AsyncIterable<unknown>;

export function isAsyncIterable(v: unknown): v is AsyncIterable<unknown> {
  return !!v && typeof (v as AsyncIterable<unknown>)[Symbol.asyncIterator] === "function";
}

/** Accepts a path, or a bare name resolved under .dcompose/scripts/ with .ts/.js/.mjs. */
export function resolveScript(script: string, projectRoot: string): string {
  const direct = isAbsolute(script) ? script : resolve(process.cwd(), script);
  if (existsSync(direct)) return direct;
  const base = join(projectRoot, ".dcompose", "scripts", script);
  for (const p of [base, `${base}.ts`, `${base}.js`, `${base}.mjs`]) if (existsSync(p)) return p;
  throw new Error(`script not found: ${script} (looked in cwd and ${join(projectRoot, ".dcompose", "scripts")})`);
}

/** Import an already-resolved script path and pick its entry export. */
export async function loadModule(path: string, label = path): Promise<ScriptFn> {
  const mod = (await import(pathToFileURL(path).href)) as Record<string, unknown>;
  const fn = mod.default ?? mod.run ?? mod.main;
  if (typeof fn !== "function") {
    throw new Error(`${label}: expected \`export default async function (ctx) { ... }\` (or a named \`run\` export)`);
  }
  return fn as ScriptFn;
}

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (
  ...a: string[]
) => (...args: unknown[]) => Promise<unknown>;

export const CTX_KEYS = [
  "mcp",
  "call",
  "input",
  "stdin",
  "pmap",
  "paginate",
  "sleep",
  "unwrap",
  "emit",
  "log",
  "runId",
  "store",
  "sh",
];

/** `dcompose eval`: try as a single expression first, then as a function body. */
export function compileInline(code: string): ScriptFn {
  const params = `{ ${CTX_KEYS.join(", ")} }`;
  let fn: (...args: unknown[]) => Promise<unknown>;
  try {
    fn = new AsyncFunction(params, `return (${code}\n);`);
  } catch {
    fn = new AsyncFunction(params, code);
  }
  return (ctx) => fn(ctx);
}
