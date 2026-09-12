import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { ConnectionError } from "../client.ts";
import { ToolError } from "../result.ts";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  recordPath,
  type DaemonRecord,
  type DaemonStatus,
  type Method,
  type Request,
  type Response,
  type WireError,
} from "./protocol.ts";

/** Thin NDJSON client. One socket, pipelined requests matched by id. */
export class DaemonClient {
  private sock: Socket;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private buf = "";
  private closed = false;

  private constructor(sock: Socket) {
    this.sock = sock;
    sock.setEncoding("utf8");
    sock.on("data", (chunk: string) => this.onData(chunk));
    sock.on("error", (e) => this.failAll(e));
    sock.on("close", () => this.failAll(new Error("daemon connection closed")));
  }

  /** Resolve to a client if a daemon answers within `timeoutMs`, else null. Never throws. */
  static async tryConnect(socketPath: string, timeoutMs = 400): Promise<DaemonClient | null> {
    return new Promise((resolve) => {
      const sock = createConnection(socketPath);
      const timer = setTimeout(() => {
        sock.destroy();
        resolve(null);
      }, timeoutMs);
      sock.once("connect", () => {
        clearTimeout(timer);
        resolve(new DaemonClient(sock));
      });
      sock.once("error", () => {
        clearTimeout(timer);
        resolve(null);
      });
    });
  }

  /** Read the per-project record and try the socket it names. Cleans up a stale record. */
  static async forProject(projectRoot: string, timeoutMs = 400): Promise<DaemonClient | null> {
    const rec = readRecord(projectRoot);
    if (!rec) return null;
    const c = await DaemonClient.tryConnect(rec.socket, timeoutMs);
    if (!c) {
      try {
        unlinkSync(recordPath(projectRoot));
      } catch {
        /* already gone */
      }
    }
    return c;
  }

  request<T = unknown>(method: Method, params?: Record<string, unknown>): Promise<T> {
    if (this.closed) return Promise.reject(new Error("daemon connection closed"));
    const id = this.nextId++;
    const req: Request = { id, method, params };
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.sock.write(JSON.stringify(req) + "\n");
    });
  }

  status(): Promise<DaemonStatus> {
    return this.request<DaemonStatus>("status");
  }

  close(): void {
    this.closed = true;
    this.sock.end();
    this.sock.destroy();
  }

  private onData(chunk: string): void {
    this.buf += chunk;
    let nl: number;
    while ((nl = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, nl);
      this.buf = this.buf.slice(nl + 1);
      if (!line.trim()) continue;
      let res: Response;
      try {
        res = JSON.parse(line) as Response;
      } catch {
        continue;
      }
      const p = this.pending.get(res.id);
      if (!p) continue;
      this.pending.delete(res.id);
      if (res.error) p.reject(rebuildError(res.error));
      else p.resolve(res.result);
    }
  }

  private failAll(e: Error): void {
    this.closed = true;
    for (const p of this.pending.values()) p.reject(e);
    this.pending.clear();
  }
}

function rebuildError(w: WireError): Error {
  switch (w.kind) {
    case "tool":
      return new ToolError(
        w.server ?? "?",
        w.tool ?? "?",
        (w.result ?? { content: [{ type: "text", text: w.message }], isError: true }) as CallToolResult,
      );
    case "connection":
      return new ConnectionError(w.server ?? "?", w.message);
    default:
      return new Error(`daemon: ${w.message}`);
  }
}

export function readRecord(projectRoot: string): DaemonRecord | null {
  const p = recordPath(projectRoot);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as DaemonRecord;
  } catch {
    return null;
  }
}
