import { spawn } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { FileOAuthProvider } from "../auth/provider.ts";
import type { Registry } from "../client.ts";
import { isStdio } from "../config.ts";
import { EXIT } from "../output.ts";

export interface AuthOptions {
  scope?: string;
  reset?: boolean;
  browser?: boolean; // commander --no-browser → false
  timeout?: number; // seconds to wait for the callback
  status?: boolean;
}

const err = (s: string) => process.stderr.write(s + "\n");

/**
 * `dcompose auth <server>`: run the OAuth 2.1 authorization-code flow (PKCE, dynamic client
 * registration, discovery all via the SDK) against a remote MCP server, store the tokens under
 * ~/.dcompose/auth/, and verify by listing tools. Later connections pick the tokens up silently.
 */
export async function authCommand(registry: Registry, name: string, opts: AuthOptions): Promise<number> {
  const server = registry.get(name);
  const cfg = server.config;
  if (isStdio(cfg)) {
    err(`dcompose: ${name} is a stdio server; it has no OAuth. Credentials for stdio servers go in its \`env\`.`);
    return EXIT.CONFIG;
  }

  if (opts.status) {
    const p = new FileOAuthProvider({ server: name, serverUrl: cfg.url });
    const t = p.tokens();
    if (!t) err(`${name}: no tokens stored (${p.path})`);
    else
      err(
        `${name}: tokens stored at ${p.path}${t.expires_in ? ` (expires_in ${t.expires_in}s at last refresh)` : ""}${t.refresh_token ? ", refresh token present" : ", no refresh token"}`,
      );
    return t ? EXIT.OK : EXIT.CONFIG;
  }

  if (opts.reset) {
    new FileOAuthProvider({ server: name, serverUrl: cfg.url }).reset();
    err(`${name}: stored OAuth state removed`);
  }

  // Loopback listener for the redirect. Port chosen by the OS; registered dynamically with the AS.
  const { port, waitForCode, close } = await startCallbackServer();
  const redirectUrl = `http://127.0.0.1:${port}/callback`;

  let authUrl: URL | null = null;
  const provider = new FileOAuthProvider({
    server: name,
    serverUrl: cfg.url,
    redirectUrl,
    scope: opts.scope,
    onRedirect: (url) => {
      authUrl = url;
      err(`\nOpen this URL to sign in to ${name}:\n\n  ${url.toString()}\n`);
      if (opts.browser !== false) openBrowser(url.toString());
      err(`Waiting for the browser to return to ${redirectUrl} …`);
    },
  });

  const makeTransport = () => {
    const url = new URL(cfg.url);
    const requestInit: RequestInit = { headers: cfg.headers };
    return cfg.type === "sse"
      ? new SSEClientTransport(url, { requestInit, authProvider: provider })
      : new StreamableHTTPClientTransport(url, { requestInit, authProvider: provider });
  };

  try {
    let transport = makeTransport();
    let client = new Client({ name: "dcompose", version: "0.1.0" }, { capabilities: {} });
    try {
      await client.connect(transport);
      if (!authUrl) {
        err(
          `${name}: already authorized${provider.hasTokens ? " (stored tokens are valid)" : " (server did not require auth)"}`,
        );
      }
    } catch (e) {
      if (!(e instanceof UnauthorizedError)) throw e;
      // The SDK has redirected (our onRedirect printed the URL). Wait for the code, exchange it, reconnect.
      const code = await waitForCode((opts.timeout ?? 300) * 1000);
      await transport.finishAuth(code);
      await transport.close().catch(() => {});
      transport = makeTransport();
      client = new Client({ name: "dcompose", version: "0.1.0" }, { capabilities: {} });
      await client.connect(transport);
    }
    const tools = await client.listTools();
    const info = client.getServerVersion();
    err(
      `${name}: authorized. ${info?.name ?? "server"} ${info?.version ?? ""} exposes ${tools.tools.length} tools. Tokens at ${provider.path}`,
    );
    await transport.close().catch(() => {});
    return EXIT.OK;
  } catch (e) {
    err(`dcompose: ${name}: ${(e as Error).message}`);
    return EXIT.CONFIG;
  } finally {
    close();
  }
}

function startCallbackServer(): Promise<{
  port: number;
  waitForCode: (timeoutMs: number) => Promise<string>;
  close: () => void;
}> {
  return new Promise((resolve, reject) => {
    let settle: { resolve: (code: string) => void; reject: (e: Error) => void } | null = null;
    const srv = createServer((req, res) => {
      const u = new URL(req.url ?? "/", "http://127.0.0.1");
      if (u.pathname !== "/callback") {
        res.writeHead(404).end();
        return;
      }
      const code = u.searchParams.get("code");
      const error = u.searchParams.get("error");
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      if (code) {
        res.end(
          "<!doctype html><title>dcompose</title><body style='font:16px system-ui;padding:2em'>Signed in. You can close this tab and return to the terminal.</body>",
        );
        settle?.resolve(code);
      } else {
        const desc = u.searchParams.get("error_description") ?? "";
        res.end(
          `<!doctype html><title>dcompose</title><body style='font:16px system-ui;padding:2em'>Authorization failed: ${escapeHtml(error ?? "no code returned")} ${escapeHtml(desc)}</body>`,
        );
        settle?.reject(new Error(`authorization failed: ${error ?? "no code"} ${desc}`.trim()));
      }
    });
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as AddressInfo).port;
      resolve({
        port,
        waitForCode: (timeoutMs) =>
          new Promise<string>((res, rej) => {
            const t = setTimeout(
              () => rej(new Error(`timed out after ${Math.round(timeoutMs / 1000)}s waiting for the browser callback`)),
              timeoutMs,
            );
            settle = {
              resolve: (c) => (clearTimeout(t), res(c)),
              reject: (e) => (clearTimeout(t), rej(e)),
            };
          }),
        close: () => srv.close(),
      });
    });
  });
}

function openBrowser(url: string): void {
  const [cmd, args] =
    process.platform === "win32"
      ? ["cmd", ["/c", "start", "", url.replace(/&/g, "^&")]]
      : process.platform === "darwin"
        ? ["open", [url]]
        : ["xdg-open", [url]];
  try {
    spawn(cmd, args, { stdio: "ignore", detached: true, windowsHide: true }).unref();
  } catch {
    /* URL was printed; the user can open it by hand */
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
