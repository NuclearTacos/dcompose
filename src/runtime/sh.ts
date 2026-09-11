import { spawn } from "node:child_process";

export interface ShOptions {
  stdin?: string;
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  /** Reject when the exit code is non-zero (default: resolve and let the script decide). */
  check?: boolean;
}

export interface ShResult {
  stdout: string;
  stderr: string;
  code: number | null;
  signal: NodeJS.Signals | null;
  ms: number;
}

/** Run a command through the platform shell. Only reachable from scripts when `--allow-exec` is set. */
export function sh(command: string, opts: ShOptions = {}): Promise<ShResult> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn(command, {
      shell: true,
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (b: Buffer) => out.push(b));
    child.stderr.on("data", (b: Buffer) => err.push(b));

    let timer: NodeJS.Timeout | undefined;
    if (opts.timeoutMs && opts.timeoutMs > 0) {
      timer = setTimeout(() => child.kill(), opts.timeoutMs);
    }

    child.on("error", (e) => {
      if (timer) clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code, signal) => {
      if (timer) clearTimeout(timer);
      const result: ShResult = {
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
        code,
        signal,
        ms: Date.now() - started,
      };
      if (opts.check && code !== 0) {
        reject(new Error(`command failed (exit ${code ?? signal}): ${command}\n${result.stderr.slice(0, 2000)}`));
      } else {
        resolve(result);
      }
    });

    if (opts.stdin !== undefined) child.stdin.end(opts.stdin);
    else child.stdin.end();
  });
}
