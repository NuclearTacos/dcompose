import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server as NetServer, type Socket } from "node:net";
import { dirname } from "node:path";
import { ConnectionError, Registry } from "../client.ts";
import { loadConfig, configHash, type Config } from "../config.ts";
import { ToolError } from "../result.ts";
import {
  recordPath,
  socketPath,
  type DaemonRecord,
  type DaemonStatus,
  type Request,
  type Response,
  type WireError,
} from "./protocol.ts";

export interface DaemonOptions {
  projectRoot: string;
  idleMs: number; // 0 = never exit on idle
  verbose?: boolean;
  log: (line: string) => void;
}

/**
 * Holds one Registry with live MCP connections and answers NDJSON requests over a local
 * socket. Stateless per request beyond the connection cache, so any number of CLI processes
 * can share it. Exits after `idleMs` without requests.
 */
export class DaemonServer {
  private registry: Registry;
  private config: Config;
  private hash: string;
  private net: NetServer | null = null;
  private readonly startedAt = Date.now();
  private requests = 0;
  private idleTimer: NodeJS.Timeout | null = null;
  private readonly opts: DaemonOptions;
  readonly socket: string;

  constructor(opts: DaemonOptions) {
    this.opts = opts;
    const loaded = loadConfig({ cwd: opts.projectRoot });
    this.config = loaded.config;
    this.hash = configHash(loaded);
    this.registry = new Registry(this.config, { verbose: opts.verbose });
    this.socket = socketPath(opts.projectRoot);
  }

  async start(): Promise<void> {
    if (process.platform !== "win32" && existsSync(this.socket)) unlinkSync(this.socket); // stale from a crash
    this.net = createServer((sock) => this.handle(sock));
    await new Promise<void>((res, rej) => {
      this.net!.once("error", rej);
      this.net!.listen(this.socket, () => res());
    });
    const rec: DaemonRecord = {
      pid: process.pid,
      socket: this.socket,
      projectRoot: this.opts.projectRoot,
      configHash: this.hash,
      startedAt: new Date(this.startedAt).toISOString(),
    };
    mkdirSync(dirname(recordPath(this.opts.projectRoot)), { recursive: true });
    writeFileSync(recordPath(this.opts.projectRoot), JSON.stringify(rec, null, 2) + "\n");
    this.touch();
    this.opts.log(`listening on ${this.socket} (pid ${process.pid}, config ${this.hash})`);

    // Warm every server in the background so the first real request is fast.
    void Promise.allSettled(this.registry.all().map((s) => s.listTools())).then((rs) => {
      const ok = rs.filter((r) => r.status === "fulfilled").length;
      this.opts.log(`warmed ${ok}/${rs.length} servers`);
    });

    const stop = () => void this.shutdown("signal");
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  }

  async shutdown(reason: string): Promise<void> {
    this.opts.log(`shutting down (${reason})`);
    if (this.idleTimer) clearTimeout(this.idleTimer);
    await new Promise<void>((res) => (this.net ? this.net.close(() => res()) : res()));
    await this.registry.closeAll();
    try {
      unlinkSync(recordPath(this.opts.projectRoot));
    } catch {
      /* gone */
    }
    if (process.platform !== "win32") {
      try {
        unlinkSync(this.socket);
      } catch {
        /* gone */
      }
    }
    process.exit(0);
  }

  private touch(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.opts.idleMs > 0) {
      this.idleTimer = setTimeout(() => void this.shutdown(`idle ${this.opts.idleMs}ms`), this.opts.idleMs);
      this.idleTimer.unref();
    }
  }

  private handle(sock: Socket): void {
    sock.setEncoding("utf8");
    let buf = "";
    sock.on("data", (chunk: string) => {
      buf += chunk;
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line.trim()) void this.dispatch(sock, line);
      }
    });
    sock.on("error", () => {
      /* client went away mid-request; nothing to do */
    });
  }

  private async dispatch(sock: Socket, line: string): Promise<void> {
    let req: Request;
    try {
      req = JSON.parse(line) as Request;
    } catch {
      return; // not ours
    }
    this.requests++;
    this.touch();
    const reply = (r: Response) => {
      if (!sock.destroyed) sock.write(JSON.stringify(r) + "\n");
    };
    try {
      const result = await this.invoke(req);
      reply({ id: req.id, result });
    } catch (e) {
      reply({ id: req.id, error: toWire(e) });
    }
  }

  private async invoke(req: Request): Promise<unknown> {
    const p = req.params ?? {};
    switch (req.method) {
      case "status":
        return this.status();
      case "listTools":
        return this.registry.get(String(p.server)).listTools();
      case "serverInfo": {
        const s = this.registry.get(String(p.server));
        await s.connect();
        return s.serverInfo() ?? null;
      }
      case "callTool": {
        const s = this.registry.get(String(p.server));
        return s.callTool(String(p.tool), (p.args as Record<string, unknown>) ?? {}, {
          raw: Boolean(p.raw),
          timeoutMs: typeof p.timeoutMs === "number" ? p.timeoutMs : undefined,
        });
      }
      case "reload": {
        // Config changed on disk: drop everything and rebuild. Connections re-warm lazily.
        await this.registry.closeAll();
        const loaded = loadConfig({ cwd: this.opts.projectRoot });
        this.config = loaded.config;
        this.hash = configHash(loaded);
        this.registry = new Registry(this.config, { verbose: this.opts.verbose });
        this.opts.log(`reloaded config (${this.hash})`);
        return { configHash: this.hash };
      }
      case "shutdown":
        setTimeout(() => void this.shutdown("requested"), 10).unref();
        return { ok: true };
      default:
        throw new Error(`unknown method ${String(req.method)}`);
    }
  }

  private status(): DaemonStatus {
    return {
      pid: process.pid,
      startedAt: new Date(this.startedAt).toISOString(),
      projectRoot: this.opts.projectRoot,
      configHash: this.hash,
      idleMs: this.opts.idleMs,
      uptimeMs: Date.now() - this.startedAt,
      requests: this.requests,
      servers: this.registry
        .all()
        .map((s) => ({ name: s.name, transport: s.transportKind, connected: s.connected, tools: s.cachedToolCount })),
    };
  }
}

function toWire(e: unknown): WireError {
  if (e instanceof ToolError)
    return { kind: "tool", message: e.message, server: e.server, tool: e.tool, result: e.result };
  if (e instanceof ConnectionError)
    return { kind: "connection", message: e.message.replace(new RegExp(`^${e.server}: `), ""), server: e.server };
  return { kind: "internal", message: (e as Error).message ?? String(e) };
}
