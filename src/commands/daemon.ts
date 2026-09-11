import { spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync, unlinkSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { findProjectRoot, loadConfig, parseDuration } from "../config.ts";
import { emitResult, EXIT, table } from "../output.ts";
import { fmtMs } from "../runtime/trace.ts";
import { DaemonClient, readRecord } from "../daemon/client.ts";
import { logPath, recordPath, socketPath } from "../daemon/protocol.ts";
import { DaemonServer } from "../daemon/server.ts";

export interface DaemonOpts {
  idle?: string;
  json?: boolean;
  foreground?: boolean;
  verbose?: boolean;
}

const err = (s: string) => process.stderr.write(s + "\n");

/** `dcompose daemon start` — spawn a detached daemon for this project, or report the one running. */
export async function daemonStart(opts: DaemonOpts): Promise<number> {
  const root = findProjectRoot();
  const existing = await DaemonClient.forProject(root);
  if (existing) {
    const s = await existing.status();
    existing.close();
    err(`daemon already running (pid ${s.pid}, up ${fmtMs(s.uptimeMs)})`);
    return EXIT.OK;
  }
  if (opts.foreground) return daemonRun(root, opts);

  const child = spawnDetached(root, opts);
  err(`starting daemon (pid ${child.pid}) … log: ${logPath(root)}`);
  const client = await waitForDaemon(root, 15_000);
  if (!client) {
    err("daemon did not come up within 15s; see the log");
    return EXIT.CONFIG;
  }
  const s = await client.status();
  client.close();
  err(`daemon ready on ${s.servers.length} server${s.servers.length === 1 ? "" : "s"}; idle timeout ${s.idleMs ? fmtMs(s.idleMs) : "off"}`);
  return EXIT.OK;
}

/** Used by auto-start: spawn if not running, return a connected client (or null on failure). */
export async function ensureDaemon(root: string, log?: (s: string) => void): Promise<DaemonClient | null> {
  const existing = await DaemonClient.forProject(root);
  if (existing) return existing;
  spawnDetached(root, {});
  log?.(`[dcompose] starting daemon for ${root}`);
  return waitForDaemon(root, 15_000);
}

function spawnDetached(root: string, opts: DaemonOpts) {
  mkdirSync(dirname(logPath(root)), { recursive: true });
  const logFd = openSync(logPath(root), "a");
  // Re-invoke this same install: src/cli.ts in dev, dist/cli.js when built.
  const here = fileURLToPath(import.meta.url);
  const cliEntry = join(dirname(dirname(here)), `cli${extname(here)}`);
  const args = [cliEntry, "daemon", "run", "--project", root];
  if (opts.idle) args.push("--idle", opts.idle);
  if (opts.verbose) args.push("--verbose");
  const child = spawn(process.execPath, args, {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    windowsHide: true,
    cwd: root,
    env: { ...process.env, DCOMPOSE_NO_DAEMON: "1" },
  });
  child.unref();
  return child;
}

async function waitForDaemon(root: string, timeoutMs: number): Promise<DaemonClient | null> {
  const deadline = Date.now() + timeoutMs;
  const sock = socketPath(root);
  while (Date.now() < deadline) {
    const c = await DaemonClient.tryConnect(sock, 300);
    if (c) return c;
    await new Promise((r) => setTimeout(r, 150));
  }
  return null;
}

/** `dcompose daemon run` — foreground server process. This is what `start` spawns. */
export async function daemonRun(root: string, opts: DaemonOpts): Promise<number> {
  const { config } = loadConfig({ cwd: root });
  const idleMs = parseDuration(opts.idle ?? config.daemon.idle);
  const log = (line: string) => process.stderr.write(`[${new Date().toISOString()}] ${line}\n`);
  const server = new DaemonServer({ projectRoot: root, idleMs, verbose: opts.verbose, log });
  try {
    await server.start();
  } catch (e) {
    log(`failed to start: ${(e as Error).message}`);
    return EXIT.CONFIG;
  }
  // Keep the event loop alive until shutdown() calls process.exit.
  await new Promise(() => {});
  return EXIT.OK;
}

export async function daemonStop(): Promise<number> {
  const root = findProjectRoot();
  const client = await DaemonClient.forProject(root);
  if (client) {
    await client.request("shutdown").catch(() => {});
    client.close();
    // Wait for the socket to actually go away so `stop && start` is safe.
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && (await DaemonClient.tryConnect(socketPath(root), 200))) await new Promise((r) => setTimeout(r, 100));
    err("daemon stopped");
    return EXIT.OK;
  }
  const rec = readRecord(root);
  if (rec) {
    try {
      process.kill(rec.pid);
      err(`daemon (pid ${rec.pid}) was not answering; sent kill`);
    } catch {
      err("stale daemon record removed");
    }
    try {
      unlinkSync(recordPath(root));
    } catch {
      /* gone */
    }
    return EXIT.OK;
  }
  err("no daemon running for this project");
  return EXIT.OK;
}

export async function daemonStatus(opts: DaemonOpts): Promise<number> {
  const root = findProjectRoot();
  const client = await DaemonClient.forProject(root);
  if (!client) {
    if (opts.json) emitResult({ running: false, projectRoot: root });
    else err(`no daemon running for ${root}`);
    return EXIT.CONFIG;
  }
  const s = await client.status();
  client.close();
  if (opts.json) {
    emitResult({ running: true, ...s });
    return EXIT.OK;
  }
  process.stdout.write(`pid ${s.pid} · up ${fmtMs(s.uptimeMs)} · ${s.requests} requests · idle timeout ${s.idleMs ? fmtMs(s.idleMs) : "off"} · config ${s.configHash}\n`);
  const rows = [["SERVER", "TRANSPORT", "STATE", "TOOLS"]];
  for (const sv of s.servers) rows.push([sv.name, sv.transport, sv.connected ? "warm" : "cold", sv.tools === null ? "-" : String(sv.tools)]);
  process.stdout.write(table(rows) + "\n");
  return EXIT.OK;
}

export async function daemonLog(lines: number): Promise<number> {
  const p = logPath(findProjectRoot());
  if (!existsSync(p)) {
    err("no daemon log yet");
    return EXIT.OK;
  }
  const all = readFileSync(p, "utf8").trimEnd().split("\n");
  process.stdout.write(all.slice(-lines).join("\n") + "\n");
  return EXIT.OK;
}

