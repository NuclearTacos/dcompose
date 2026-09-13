// Parent half of `--isolate`: run the script in a child process under Node's permission model and
// serve its MCP calls and store access over IPC. Credentials, connections, guardrails, and the
// trace all stay in this process; the child sees a proxy context and nothing else.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { GuardrailError, type Ctx, type McpProxy } from "./context.ts";

export interface WireError {
  name: string;
  message: string;
  reason?: string;
}

export type ChildToParent =
  | { t: "ready" }
  | { t: "req"; id: number; op: "call"; server: string; tool: string; args?: Record<string, unknown>; raw: boolean }
  | { t: "req"; id: number; op: "qualified"; qualified: string; args?: Record<string, unknown> }
  | {
      t: "req";
      id: number;
      op: "store";
      method: "get" | "set" | "delete" | "all" | "clear";
      key?: string;
      value?: unknown;
    }
  | { t: "value"; value?: unknown }
  | { t: "stream" }
  | { t: "item"; value?: unknown }
  | { t: "end" }
  | { t: "error"; error: WireError };

export type ParentToChild =
  | {
      t: "start";
      script?: string;
      code?: string;
      input: unknown;
      runId: string;
      servers: string[];
      storePath: string;
      concurrency: number;
    }
  | { t: "res"; id: number; ok: true; value?: unknown }
  | { t: "res"; id: number; ok: false; error: WireError };

export interface IsolateOptions {
  /** The real context; its guardrails run on every proxied call. */
  ctx: Ctx;
  /** Resolved absolute script path, or undefined for eval. */
  script?: string;
  code?: string;
  projectRoot: string;
  servers: string[];
  concurrency: number;
}

export interface IsolatedRun {
  /** Resolves with the script's return value, or with an AsyncIterable for streaming scripts. */
  result: Promise<unknown>;
  /** Stop the child if it is still running. Safe to call repeatedly. */
  kill(): void;
}

/** True when this Node build denies network access under --permission (it has --allow-net to grant it). */
export function netRestricted(): boolean {
  return process.allowedNodeEnvironmentFlags.has("--allow-net");
}

const PACKAGE_ROOT = resolve(import.meta.dirname, "..", "..");
const CHILD_ENTRY = join(import.meta.dirname, `isolate-child${extname(import.meta.filename)}`);

/** Directories the child may read: its own script tree, the project's dependencies, and dcompose itself. */
export function readablePaths(opts: Pick<IsolateOptions, "script" | "projectRoot">): string[] {
  const out = new Set<string>([PACKAGE_ROOT]);
  if (opts.script) out.add(dirname(opts.script));
  const mods = join(opts.projectRoot, "node_modules");
  if (existsSync(mods)) out.add(mods);
  return [...out];
}

const ENV_KEEP =
  /^(PATH|SYSTEMROOT|WINDIR|SYSTEMDRIVE|COMSPEC|PATHEXT|TEMP|TMP|TMPDIR|NO_COLOR|FORCE_COLOR|TERM|LANG|LC_ALL)$/i;

/** A minimal environment: enough for Node to start, none of the parent's secrets. */
export function childEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (ENV_KEEP.test(k) && v !== undefined) env[k] = v;
  env.DCOMPOSE_ISOLATED = "1";
  if (process.env.DCOMPOSE_RUN_ID) env.DCOMPOSE_RUN_ID = process.env.DCOMPOSE_RUN_ID;
  return env;
}

export function toWire(e: unknown): WireError {
  if (e instanceof GuardrailError) return { name: e.name, message: e.message, reason: e.reason };
  if (e instanceof Error) return { name: e.name, message: e.message };
  return { name: "Error", message: String(e) };
}

export function fromWire(w: WireError): Error {
  if (w.name === "GuardrailError") return new GuardrailError(w.reason ?? "guardrail", w.message);
  const e = new Error(w.message);
  e.name = w.name;
  return e;
}

export function startIsolated(opts: IsolateOptions): IsolatedRun {
  const args = ["--permission", ...readablePaths(opts).map((p) => `--allow-fs-read=${p}`), CHILD_ENTRY];
  const child: ChildProcess = spawn(process.execPath, args, {
    // stdin passes through for ctx.stdin; the child's stdout is not ours to print, so it lands on stderr.
    stdio: ["inherit", "pipe", "inherit", "ipc"],
    env: childEnv(),
    cwd: opts.projectRoot,
    windowsHide: true,
  });
  child.stdout?.pipe(process.stderr);

  let settled = false;
  let killed = false;
  const kill = (): void => {
    if (killed) return;
    killed = true;
    if (child.exitCode === null && child.signalCode === null) child.kill();
  };

  const queue: ChildToParent[] = [];
  let waiter: ((m: ChildToParent) => void) | null = null;
  const nextMessage = (): Promise<ChildToParent> =>
    new Promise((res) => {
      const m = queue.shift();
      if (m) res(m);
      else waiter = res;
    });
  const push = (m: ChildToParent): void => {
    if (waiter) {
      const w = waiter;
      waiter = null;
      w(m);
    } else queue.push(m);
  };

  const reply = (m: ParentToChild): void => {
    if (child.connected) child.send(m);
  };
  const respond = (id: number, p: Promise<unknown>): void => {
    p.then(
      (value) => reply({ t: "res", id, ok: true, value }),
      (e) => reply({ t: "res", id, ok: false, error: toWire(e) }),
    );
  };

  const handleRequest = (m: Extract<ChildToParent, { t: "req" }>): void => {
    const { ctx } = opts;
    switch (m.op) {
      case "call": {
        respond(
          m.id,
          Promise.resolve().then(() => {
            const proxy = (ctx.mcp as McpProxy)[m.server]!;
            return m.raw ? proxy.raw[m.tool]!(m.args) : proxy[m.tool]!(m.args);
          }),
        );
        return;
      }
      case "qualified":
        respond(
          m.id,
          Promise.resolve().then(() => ctx.call(m.qualified as `${string}.${string}`, m.args)),
        );
        return;
      case "store": {
        const s = ctx.store;
        respond(
          m.id,
          Promise.resolve().then(() => {
            switch (m.method) {
              case "get":
                return s.get(m.key!);
              case "set":
                return s.set(m.key!, m.value);
              case "delete":
                return s.delete(m.key!);
              case "all":
                return s.all();
              case "clear":
                return s.clear();
            }
          }),
        );
        return;
      }
    }
  };

  const result = new Promise<unknown>((resolve, reject) => {
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      fn();
    };

    child.on("message", (raw) => {
      const m = raw as ChildToParent;
      switch (m.t) {
        case "ready":
          reply({
            t: "start",
            script: opts.script,
            code: opts.code,
            input: opts.ctx.input,
            runId: opts.ctx.runId,
            servers: opts.servers,
            storePath: opts.ctx.store.path,
            concurrency: opts.concurrency,
          });
          return;
        case "req":
          handleRequest(m);
          return;
        case "value":
          finish(() => resolve(m.value));
          return;
        case "error":
          finish(() => reject(fromWire(m.error)));
          return;
        case "stream":
          finish(() => resolve(streamItems()));
          return;
        case "item":
        case "end":
          push(m);
          return;
      }
    });
    child.on("error", (e) => finish(() => reject(e)));
    child.on("close", (code, signal) => {
      // Give queued IPC messages a tick to land before deciding the child died silently.
      setTimeout(() => {
        const why = signal ? `signal ${signal}` : `exit code ${code}`;
        finish(() => reject(new Error(`isolated script process ended unexpectedly (${why})`)));
        push({ t: "error", error: { name: "Error", message: `isolated script process ended (${why})` } });
      }, 20);
    });
  });

  async function* streamItems(): AsyncGenerator<unknown> {
    for (;;) {
      const m = await nextMessage();
      if (m.t === "item") yield m.value;
      else if (m.t === "end") return;
      else if (m.t === "error") throw fromWire(m.error);
    }
  }

  return { result, kill };
}
