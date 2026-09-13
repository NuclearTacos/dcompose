import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { isStdio, type Config, type ServerConfig } from "./config.ts";
import { parseResult, ToolError } from "./result.ts";
import { FileOAuthProvider, NeedsAuthError } from "./auth/provider.ts";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";

export class ConnectionError extends Error {
  readonly server: string;
  constructor(server: string, message: string, options?: ErrorOptions) {
    super(`${server}: ${message}`, options);
    this.name = "ConnectionError";
    this.server = server;
  }
}

export interface ToolInfo extends Tool {
  server: string;
  readOnly: boolean;
}

export interface CallOptions {
  /** Return the raw MCP result instead of the parsed value. */
  raw?: boolean;
  timeoutMs?: number;
}

const CLIENT_INFO = { name: "dcompose", version: "0.1.0" };

/** What a Server needs from a daemon to delegate instead of connecting itself. */
export interface RemoteBackend {
  request<T = unknown>(method: "listTools" | "callTool" | "serverInfo", params: Record<string, unknown>): Promise<T>;
}

export class Server {
  readonly name: string;
  readonly config: ServerConfig;
  private client: Client | null = null;
  private transport: Transport | null = null;
  private connecting: Promise<void> | null = null;
  private toolCache: ToolInfo[] | null = null;
  private stderrTail: string[] = [];
  private readonly connectTimeoutMs: number;
  private readonly verbose: boolean;
  /** When set, every operation goes over the daemon socket; no local MCP connection is made. */
  private readonly remote: RemoteBackend | null;
  private remoteInfo: { name?: string; version?: string } | null = null;

  constructor(
    name: string,
    config: ServerConfig,
    opts: { connectTimeoutMs: number; verbose: boolean; remote?: RemoteBackend | null },
  ) {
    this.name = name;
    this.config = config;
    this.connectTimeoutMs = opts.connectTimeoutMs;
    this.verbose = opts.verbose;
    this.remote = opts.remote ?? null;
  }

  get transportKind(): "stdio" | "http" | "sse" {
    return isStdio(this.config) ? "stdio" : this.config.type;
  }

  get connected(): boolean {
    return this.client !== null || this.remoteInfo !== null;
  }

  get viaDaemon(): boolean {
    return this.remote !== null;
  }

  /** Tool count if tools were listed already; null otherwise. Cheap; never connects. */
  get cachedToolCount(): number | null {
    return this.toolCache?.length ?? null;
  }

  /** Idempotent; concurrent callers share one connection attempt. */
  connect(): Promise<void> {
    if (this.remote) {
      if (this.remoteInfo) return Promise.resolve();
      return this.remote
        .request<{ name?: string; version?: string } | null>("serverInfo", { server: this.name })
        .then((info) => {
          this.remoteInfo = info ?? {};
        });
    }
    if (this.client) return Promise.resolve();
    if (!this.connecting) this.connecting = this.doConnect().finally(() => (this.connecting = null));
    return this.connecting;
  }

  private async doConnect(): Promise<void> {
    const transport = this.makeTransport();
    const client = new Client(CLIENT_INFO, { capabilities: {} });

    const timer = new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error(`connect timed out after ${this.connectTimeoutMs}ms`)),
        this.connectTimeoutMs,
      ).unref(),
    );

    try {
      await Promise.race([client.connect(transport), timer]);
    } catch (e) {
      await transport.close().catch(() => {});
      const detail = this.describeFailure(e as Error);
      throw new ConnectionError(this.name, detail, { cause: e });
    }
    this.client = client;
    this.transport = transport;
    // If the server process dies or the HTTP session drops, forget it so the next call reconnects.
    // Matters for the daemon, which lives much longer than any single MCP server might.
    transport.onclose = () => {
      if (this.transport === transport) {
        this.client = null;
        this.transport = null;
        this.toolCache = null;
      }
    };
  }

  private makeTransport(): Transport {
    const c = this.config;
    if (isStdio(c)) {
      // Match Claude Code: child inherits the full environment, config env overrides.
      const env: Record<string, string> = {};
      for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
      Object.assign(env, c.env);

      const t = new StdioClientTransport({ command: c.command, args: c.args, env, cwd: c.cwd, stderr: "pipe" });
      t.stderr?.on("data", (chunk: Buffer) => {
        const text = chunk.toString("utf8");
        if (this.verbose) process.stderr.write(`[${this.name}] ${text}`);
        for (const line of text.split(/\r?\n/)) {
          if (!line) continue;
          this.stderrTail.push(line);
          if (this.stderrTail.length > 20) this.stderrTail.shift();
        }
      });
      return t;
    }

    const url = new URL(c.url);
    const requestInit: RequestInit = { headers: c.headers };
    // Non-interactive provider: uses tokens saved by `dcompose auth`, refreshes them, and throws
    // NeedsAuthError instead of opening a browser when the server demands a fresh sign-in.
    const authProvider = new FileOAuthProvider({ server: this.name, serverUrl: c.url });
    if (c.type === "sse") return new SSEClientTransport(url, { requestInit, authProvider });
    return new StreamableHTTPClientTransport(url, { requestInit, authProvider });
  }

  private describeFailure(e: Error): string {
    const cause = (e as { cause?: { message?: string } }).cause?.message;
    const msg = cause ? `${e.message} (${cause})` : (e.message ?? String(e));
    const parts = [msg];
    if (e instanceof NeedsAuthError || e instanceof UnauthorizedError || /401|unauthorized/i.test(msg)) {
      parts.push(
        `Server requires authentication. Run \`dcompose auth ${this.name}\` to sign in with OAuth, or supply a static token via \`headers\`.`,
      );
    }
    if (isStdio(this.config)) {
      if (/ENOENT/.test(msg)) parts.push(`Command not found: ${this.config.command}`);
      if (this.stderrTail.length) parts.push("server stderr:\n  " + this.stderrTail.join("\n  "));
    }
    return parts.join("\n");
  }

  async listTools(): Promise<ToolInfo[]> {
    if (this.toolCache) return this.toolCache;
    if (this.remote) {
      this.toolCache = await this.remote.request<ToolInfo[]>("listTools", { server: this.name });
      return this.toolCache;
    }
    await this.connect();
    const tools: Tool[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.client!.listTools(cursor ? { cursor } : undefined);
      tools.push(...page.tools);
      cursor = page.nextCursor;
    } while (cursor);
    this.toolCache = tools.map((t) => ({ ...t, server: this.name, readOnly: t.annotations?.readOnlyHint === true }));
    return this.toolCache;
  }

  async callTool(tool: string, args: Record<string, unknown> = {}, opts: CallOptions = {}): Promise<unknown> {
    if (this.remote) {
      return this.remote.request("callTool", {
        server: this.name,
        tool,
        args,
        raw: opts.raw ?? false,
        timeoutMs: opts.timeoutMs,
      });
    }
    await this.connect();
    const result = (await this.client!.callTool(
      { name: tool, arguments: args },
      undefined,
      opts.timeoutMs ? { timeout: opts.timeoutMs } : undefined,
    )) as CallToolResult;
    if (result.isError) throw new ToolError(this.name, tool, result);
    return opts.raw ? result : parseResult(result);
  }

  serverInfo(): { name?: string; version?: string } | undefined {
    if (this.remote) return this.remoteInfo ?? undefined;
    return this.client?.getServerVersion();
  }

  async close(): Promise<void> {
    const t = this.transport;
    this.client = null;
    this.transport = null;
    this.toolCache = null;
    if (t) await t.close().catch(() => {});
  }
}

export class Registry {
  private readonly servers = new Map<string, Server>();
  /** Non-null when every server is delegated to a running daemon. */
  readonly remote: RemoteBackend | null;

  constructor(config: Config, opts: { verbose?: boolean; remote?: RemoteBackend | null } = {}) {
    this.remote = opts.remote ?? null;
    for (const [name, sc] of Object.entries(config.mcpServers)) {
      this.servers.set(
        name,
        new Server(name, sc, {
          connectTimeoutMs: config.defaults.connectTimeoutMs,
          verbose: opts.verbose ?? false,
          remote: this.remote,
        }),
      );
    }
  }

  get viaDaemon(): boolean {
    return this.remote !== null;
  }

  names(): string[] {
    return [...this.servers.keys()];
  }

  get(name: string): Server {
    const s = this.servers.get(name);
    if (!s) {
      const known = this.names();
      throw new ConnectionError(
        name,
        known.length
          ? `unknown server. Known: ${known.join(", ")}`
          : "unknown server. No servers configured; run `dcompose init`.",
      );
    }
    return s;
  }

  all(): Server[] {
    return [...this.servers.values()];
  }

  /** Resolve `server.tool` (split on the first dot). */
  resolve(qualified: string): { server: Server; tool: string } {
    const i = qualified.indexOf(".");
    if (i <= 0 || i === qualified.length - 1) {
      throw new ConnectionError(qualified, "expected <server>.<tool>");
    }
    return { server: this.get(qualified.slice(0, i)), tool: qualified.slice(i + 1) };
  }

  async closeAll(): Promise<void> {
    await Promise.all(this.all().map((s) => s.close()));
  }
}
