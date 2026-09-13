import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { dcomposeHome } from "../config.ts";

/** NDJSON request/response over a local socket. One JSON object per line. */

export interface Request {
  id: number;
  method: Method;
  params?: Record<string, unknown>;
}

export type Method = "status" | "listTools" | "callTool" | "serverInfo" | "reload" | "shutdown";

export interface Response {
  id: number;
  result?: unknown;
  error?: WireError;
}

export interface WireError {
  /** Which client-side error class to rebuild. */
  kind: "tool" | "connection" | "internal";
  message: string;
  server?: string;
  tool?: string;
  /** Raw CallToolResult for kind === "tool". */
  result?: unknown;
}

export interface DaemonStatus {
  pid: number;
  startedAt: string;
  projectRoot: string;
  configHash: string;
  idleMs: number;
  uptimeMs: number;
  requests: number;
  servers: { name: string; transport: string; connected: boolean; tools: number | null }[];
}

export interface DaemonRecord {
  pid: number;
  socket: string;
  projectRoot: string;
  configHash: string;
  startedAt: string;
}

export function daemonDir(): string {
  return join(dcomposeHome(), "daemons");
}

export function projectKey(projectRoot: string): string {
  return createHash("sha1").update(projectRoot.toLowerCase().replace(/\\/g, "/")).digest("hex").slice(0, 12);
}

/** Windows: named pipe. Elsewhere: a socket file under ~/.dcompose/daemons/. */
export function socketPath(projectRoot: string): string {
  const key = projectKey(projectRoot);
  if (process.platform === "win32") return `\\\\.\\pipe\\dcompose-${key}`;
  const dir = daemonDir();
  mkdirSync(dir, { recursive: true });
  return join(dir, `${key}.sock`);
}

export function recordPath(projectRoot: string): string {
  return join(projectRoot, ".dcompose", "daemon.json");
}

export function logPath(projectRoot: string): string {
  return join(projectRoot, ".dcompose", "daemon.log");
}
