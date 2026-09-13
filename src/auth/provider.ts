import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";

export const AUTH_DIR = join(homedir(), ".dcompose", "auth");

/** Thrown when a server needs OAuth and nobody is there to complete the browser flow. */
export class NeedsAuthError extends Error {
  readonly server: string;
  constructor(server: string) {
    super(`${server} requires OAuth; run \`dcompose auth ${server}\` once to sign in`);
    this.name = "NeedsAuthError";
    this.server = server;
  }
}

interface Persisted {
  serverUrl: string;
  clientInformation?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
  codeVerifier?: string;
  updatedAt: string;
}

export interface ProviderOptions {
  /** Server name from config; used in messages and to key the token file. */
  server: string;
  serverUrl: string;
  /** Where the authorization server should send the browser back. Only needed interactively. */
  redirectUrl?: string;
  scope?: string;
  /** Called with the authorization URL during `dcompose auth`. Absent = non-interactive: throw NeedsAuthError. */
  onRedirect?: (url: URL) => void | Promise<void>;
  /** Override the storage directory (tests). Defaults to ~/.dcompose/auth or $DCOMPOSE_AUTH_DIR. */
  dir?: string;
}

/**
 * OAuth 2.1 client state persisted at ~/.dcompose/auth/<server>-<urlhash>.json.
 * The SDK handles discovery, PKCE, dynamic client registration, code exchange, and refresh;
 * this class only stores what it hands us and decides what to do when a browser is needed.
 */
export class FileOAuthProvider implements OAuthClientProvider {
  readonly path: string;
  private readonly opts: ProviderOptions;
  private data: Persisted;

  constructor(opts: ProviderOptions) {
    this.opts = opts;
    this.path = tokenPath(opts.server, opts.serverUrl, opts.dir);
    this.data = this.load();
  }

  static exists(server: string, serverUrl: string): boolean {
    return existsSync(tokenPath(server, serverUrl));
  }

  get redirectUrl(): string | undefined {
    return this.opts.redirectUrl;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "dcompose",
      client_uri: "https://github.com/NuclearTacos/dcompose",
      redirect_uris: this.opts.redirectUrl ? [this.opts.redirectUrl] : [],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      ...(this.opts.scope ? { scope: this.opts.scope } : {}),
    };
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    return this.data.clientInformation;
  }

  saveClientInformation(info: OAuthClientInformationMixed): void {
    this.data.clientInformation = info;
    this.flush();
  }

  tokens(): OAuthTokens | undefined {
    return this.data.tokens;
  }

  saveTokens(tokens: OAuthTokens): void {
    this.data.tokens = tokens;
    this.flush();
  }

  async redirectToAuthorization(url: URL): Promise<void> {
    if (!this.opts.onRedirect) throw new NeedsAuthError(this.opts.server);
    await this.opts.onRedirect(url);
  }

  saveCodeVerifier(v: string): void {
    this.data.codeVerifier = v;
    this.flush();
  }

  codeVerifier(): string {
    if (!this.data.codeVerifier) throw new Error("no PKCE code verifier saved; restart `dcompose auth`");
    return this.data.codeVerifier;
  }

  invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): void {
    if (scope === "all") this.data = { serverUrl: this.opts.serverUrl, updatedAt: new Date().toISOString() };
    if (scope === "all" || scope === "client") delete this.data.clientInformation;
    if (scope === "all" || scope === "tokens") delete this.data.tokens;
    if (scope === "all" || scope === "verifier") delete this.data.codeVerifier;
    this.flush();
  }

  /** True when an access token is stored (it may still be expired; the SDK refreshes). */
  get hasTokens(): boolean {
    return !!this.data.tokens?.access_token;
  }

  reset(): void {
    if (existsSync(this.path)) unlinkSync(this.path);
    this.data = { serverUrl: this.opts.serverUrl, updatedAt: new Date().toISOString() };
  }

  private load(): Persisted {
    if (!existsSync(this.path)) return { serverUrl: this.opts.serverUrl, updatedAt: new Date().toISOString() };
    try {
      return JSON.parse(readFileSync(this.path, "utf8")) as Persisted;
    } catch {
      return { serverUrl: this.opts.serverUrl, updatedAt: new Date().toISOString() };
    }
  }

  private flush(): void {
    this.data.updatedAt = new Date().toISOString();
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const tmp = `${this.path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 2) + "\n", { mode: 0o600 });
    renameSync(tmp, this.path);
  }
}

export function tokenPath(server: string, serverUrl: string, dir = process.env.DCOMPOSE_AUTH_DIR || AUTH_DIR): string {
  const safe = server.replace(/[^A-Za-z0-9._-]+/g, "_");
  const hash = createHash("sha1").update(serverUrl).digest("hex").slice(0, 8);
  return join(dir, `${safe}-${hash}.json`);
}
