import { readFileSync } from "node:fs";
import type { Registry } from "../client.ts";
import { pmap, type PmapOptions } from "./pmap.ts";
import { sh as runSh, type ShOptions, type ShResult } from "./sh.ts";
import type { Store } from "./store.ts";
import { byteLength, type RunTrace } from "./trace.ts";

/** A callable tool: `mcp.server.tool(args)`. */
export type ToolFn = (args?: Record<string, unknown>) => Promise<any>;

/** One server's tools. `raw` returns the unparsed MCP envelope. */
export type ServerProxy = { [tool: string]: ToolFn } & { raw: { [tool: string]: ToolFn } };

export interface McpProxy {
  [server: string]: ServerProxy;
}

/**
 * Augmented by the generated `.dcompose/types/mcp.d.ts`:
 *
 *   declare module "dcompose" { interface McpServers { pagerduty: Pagerduty } }
 *
 * When augmented, `ctx.mcp` is strictly typed; otherwise it falls back to the `any` proxy.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface McpServers {}

export type Mcp = keyof McpServers extends never ? McpProxy : McpServers;

export interface StdinHelper {
  /** True when stdin is a pipe or file rather than a terminal. */
  readonly piped: boolean;
  text(): Promise<string>;
  json<T = unknown>(): Promise<T>;
  /** Non-empty lines, streamed. */
  lines(): AsyncIterable<string>;
  /** Each non-empty line parsed as JSON. */
  jsonl<T = unknown>(): AsyncIterable<T>;
}

export interface Ctx<I = any> {
  /** Typed once `dcompose types` has run; `any` otherwise. */
  mcp: Mcp;
  /** Call by qualified name when the tool name is not a valid identifier. */
  call(qualified: `${string}.${string}`, args?: Record<string, unknown>): Promise<any>;
  /** From --input / --input-file / --input -. `{}` when absent. */
  input: I;
  stdin: StdinHelper;
  pmap<T, R>(items: Iterable<T>, fn: (item: T, index: number) => Promise<R> | R, opts?: PmapOptions): Promise<R[]>;
  sleep(ms: number): Promise<void>;
  /** One NDJSON line on stderr; interim events that are not the return value. */
  emit(event: unknown): void;
  /** Human-readable stderr line. */
  log(...parts: unknown[]): void;
  runId: string;
  /** Tool calls made so far in this run. */
  readonly calls: number;
  /** JSON key-value store persisted at .dcompose/state/<script>.json; survives relaunches. */
  store: Store;
  /**
   * Run a shell command. Requires `--allow-exec`; otherwise throws a GuardrailError.
   * Counts toward --max-calls and appears in the run trace as `$sh`.
   */
  sh(command: string, opts?: ShOptions): Promise<ShResult>;
}

export class GuardrailError extends Error {
  readonly reason: string;
  constructor(reason: string, message: string) {
    super(message);
    this.name = "GuardrailError";
    this.reason = reason;
  }
}

export interface ContextOptions {
  registry: Registry;
  trace: RunTrace;
  input: unknown;
  maxCalls: number; // 0 = unlimited
  defaultConcurrency: number;
  callTimeoutMs?: number;
  /** Tools the script may call. Undefined = all. Checked as `server.tool` globs. */
  allow?: (qualified: string) => boolean;
  readOnly?: boolean;
  dryRun?: boolean;
  store: Store;
  allowExec?: boolean;
}

export function buildContext(opts: ContextOptions): Ctx {
  const { registry, trace } = opts;

  async function shell(command: string, shOpts?: ShOptions): Promise<ShResult> {
    if (!opts.allowExec) throw new GuardrailError("exec-denied", `sh() requires --allow-exec; refused: ${command.slice(0, 80)}`);
    if (opts.maxCalls > 0 && trace.calls >= opts.maxCalls) throw new GuardrailError("max-calls", `call budget exhausted (${opts.maxCalls}); attempted sh()`);
    const label = command.trim().split(/\s+/)[0] ?? "sh";
    if (opts.dryRun) {
      trace.record({ server: "$sh", tool: label, argsBytes: byteLength(command), ms: 0, resultBytes: 0 });
      process.stderr.write(`[dry-run] $ ${command}\n`);
      return { stdout: "", stderr: "", code: 0, signal: null, ms: 0 };
    }
    const started = Date.now();
    try {
      const r = await runSh(command, shOpts);
      trace.record({ server: "$sh", tool: label, argsBytes: byteLength(command), ms: Date.now() - started, resultBytes: byteLength(r.stdout), error: r.code === 0 ? undefined : `exit ${r.code}` });
      return r;
    } catch (e) {
      trace.record({ server: "$sh", tool: label, argsBytes: byteLength(command), ms: Date.now() - started, resultBytes: 0, error: (e as Error).message });
      throw e;
    }
  }

  async function invoke(server: string, tool: string, args: Record<string, unknown> | undefined, raw: boolean): Promise<unknown> {
    const qualified = `${server}.${tool}`;
    if (opts.maxCalls > 0 && trace.calls >= opts.maxCalls) {
      throw new GuardrailError("max-calls", `call budget exhausted (${opts.maxCalls}); attempted ${qualified}`);
    }
    if (opts.allow && !opts.allow(qualified)) {
      throw new GuardrailError("denied", `${qualified} is not in the allow list`);
    }
    const s = registry.get(server);
    if (opts.readOnly) {
      const info = (await s.listTools()).find((t) => t.name === tool);
      if (!info) throw new Error(`${qualified}: unknown tool`);
      if (!info.readOnly) throw new GuardrailError("read-only", `${qualified} is not marked readOnlyHint and --read-only is set`);
    }

    const started = Date.now();
    if (opts.dryRun) {
      trace.record({ server, tool, argsBytes: byteLength(args ?? {}), ms: 0, resultBytes: 0 });
      process.stderr.write(`[dry-run] ${qualified} ${JSON.stringify(args ?? {})}\n`);
      return null;
    }
    try {
      const result = await s.callTool(tool, args ?? {}, { raw, timeoutMs: opts.callTimeoutMs });
      trace.record({ server, tool, argsBytes: byteLength(args ?? {}), ms: Date.now() - started, resultBytes: byteLength(result) });
      return result;
    } catch (e) {
      trace.record({ server, tool, argsBytes: byteLength(args ?? {}), ms: Date.now() - started, resultBytes: 0, error: (e as Error).message });
      throw e;
    }
  }

  const serverProxy = (server: string, raw: boolean): ServerProxy =>
    new Proxy({} as ServerProxy, {
      get(_t, prop) {
        if (typeof prop !== "string") return undefined;
        if (prop === "then") return undefined; // not a thenable
        if (prop === "raw" && !raw) return serverProxy(server, true);
        return (args?: Record<string, unknown>) => invoke(server, prop, args, raw);
      },
      has: () => true,
    });

  const serverCache = new Map<string, ServerProxy>();
  const mcp = new Proxy({} as McpProxy, {
    get(_t, prop) {
      if (typeof prop !== "string" || prop === "then") return undefined;
      registry.get(prop); // throws with the known-server list if misspelled
      let p = serverCache.get(prop);
      if (!p) serverCache.set(prop, (p = serverProxy(prop, false)));
      return p;
    },
    ownKeys: () => registry.names(),
    getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true }),
  });

  return {
    mcp,
    call(qualified, args) {
      const { server, tool } = registry.resolve(qualified);
      return invoke(server.name, tool, args, false);
    },
    input: opts.input ?? {},
    stdin: makeStdin(),
    pmap: (items, fn, o) => pmap(items, fn, { concurrency: opts.defaultConcurrency, ...o }),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    emit: (event) => process.stderr.write(JSON.stringify(event) + "\n"),
    log: (...parts) => process.stderr.write(parts.map((p) => (typeof p === "string" ? p : JSON.stringify(p))).join(" ") + "\n"),
    runId: trace.header.runId,
    get calls() {
      return trace.calls;
    },
    store: opts.store,
    sh: shell,
  };
}

function makeStdin(): StdinHelper {
  const piped = !process.stdin.isTTY;
  let cached: string | null = null;
  const text = async (): Promise<string> => {
    if (!piped) return "";
    if (cached === null) cached = readFileSync(0, "utf8");
    return cached;
  };
  async function* lines(): AsyncIterable<string> {
    for (const l of (await text()).split(/\r?\n/)) if (l.trim() !== "") yield l;
  }
  async function* jsonl<T>(): AsyncIterable<T> {
    for await (const l of lines()) yield JSON.parse(l) as T;
  }
  return {
    piped,
    text,
    json: async <T>() => JSON.parse(await text()) as T,
    lines,
    jsonl,
  };
}
