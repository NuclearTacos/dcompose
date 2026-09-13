// Child half of `--isolate`. Started by isolate.ts under `node --permission`; talks to the parent over
// IPC only. Anything here that touches the filesystem, spawns a process, or opens a socket is denied
// by Node before it runs.
import { GuardrailError, makeMcpProxy, makeStdin, paginate, unwrap, type Ctx } from "./context.ts";
import { pmap } from "./pmap.ts";
import { compileInline, isAsyncIterable, loadModule } from "./load.ts";
import type { Store } from "./store.ts";
import type { ChildToParent, ParentToChild, WireError } from "./isolate.ts";

const send = (m: ChildToParent, cb?: () => void): void => {
  process.send!(m, undefined, undefined, cb ? () => cb() : undefined);
};

let nextId = 1;
const pending = new Map<number, { res: (v: unknown) => void; rej: (e: Error) => void }>();

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type Request = DistributiveOmit<Extract<ChildToParent, { t: "req" }>, "id">;

function request(m: Request): Promise<unknown> {
  const id = nextId++;
  return new Promise((res, rej) => {
    pending.set(id, { res, rej });
    send({ ...m, id } as ChildToParent);
  });
}

function revive(w: WireError): Error {
  if (w.name === "GuardrailError") return new GuardrailError(w.reason ?? "guardrail", w.message);
  const e = new Error(w.message);
  e.name = w.name;
  return e;
}

function toWire(e: unknown): WireError {
  if (e instanceof GuardrailError) return { name: e.name, message: e.message, reason: e.reason };
  if (e instanceof Error) return { name: e.name, message: e.message };
  return { name: "Error", message: String(e) };
}

function exitAfter(m: ChildToParent, code: number): void {
  send(m, () => process.exit(code));
}

async function start(m: Extract<ParentToChild, { t: "start" }>): Promise<void> {
  const names = m.servers;
  let calls = 0;
  const invoke = (server: string, tool: string, args: Record<string, unknown> | undefined, raw: boolean) => {
    calls++;
    return request({ t: "req", op: "call", server, tool, args, raw });
  };
  const mcp = makeMcpProxy({
    names: () => names,
    assertServer: (name) => {
      if (!names.includes(name)) throw new Error(`unknown server "${name}" (known: ${names.join(", ") || "none"})`);
    },
    invoke,
  });
  const store: Store = {
    path: m.storePath,
    get: (key) => request({ t: "req", op: "store", method: "get", key }) as Promise<never>,
    set: (key, value) => request({ t: "req", op: "store", method: "set", key, value }) as Promise<void>,
    delete: (key) => request({ t: "req", op: "store", method: "delete", key }) as Promise<void>,
    all: () => request({ t: "req", op: "store", method: "all" }) as Promise<Record<string, unknown>>,
    clear: () => request({ t: "req", op: "store", method: "clear" }) as Promise<void>,
  };
  const ctx: Ctx = {
    mcp,
    call(qualified, args) {
      calls++;
      return request({ t: "req", op: "qualified", qualified, args });
    },
    input: m.input ?? {},
    stdin: makeStdin(),
    pmap: (items, fn, o) => pmap(items, fn, { concurrency: m.concurrency, ...o }),
    paginate,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    unwrap,
    emit: (event) => process.stderr.write(JSON.stringify(event) + "\n"),
    log: (...parts) =>
      process.stderr.write(parts.map((p) => (typeof p === "string" ? p : JSON.stringify(p))).join(" ") + "\n"),
    runId: m.runId,
    get calls() {
      return calls;
    },
    store,
    sh: async (command) => {
      throw new GuardrailError("exec-denied", `sh() is unavailable under --isolate; refused: ${command.slice(0, 80)}`);
    },
  };

  const fn = m.code !== undefined ? compileInline(m.code) : await loadModule(m.script!);
  const result = await fn(ctx);
  if (isAsyncIterable(result)) {
    send({ t: "stream" });
    for await (const item of result) send({ t: "item", value: item });
    exitAfter({ t: "end" }, 0);
  } else {
    exitAfter({ t: "value", value: result }, 0);
  }
}

process.on("message", (raw) => {
  const m = raw as ParentToChild;
  if (m.t === "res") {
    const p = pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    if (m.ok) p.res(m.value);
    else p.rej(revive(m.error));
  } else if (m.t === "start") {
    start(m).catch((e: unknown) => exitAfter({ t: "error", error: toWire(e) }, 1));
  }
});

send({ t: "ready" });
