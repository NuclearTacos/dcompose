import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { paginate, GuardrailError } from "../src/runtime/context.ts";
import { FileOAuthProvider, NeedsAuthError, tokenPath } from "../src/auth/provider.ts";

const ROOT = resolve(import.meta.dirname, "..");
// Isolate from the developer's real ~/.dcompose (user config, auth tokens, daemon records).
process.env.DCOMPOSE_HOME = mkdtempSync(join(tmpdir(), "dcompose-home-"));
const CLI = join(ROOT, "src", "cli.ts");
const FIXTURE = join(ROOT, "test", "fixtures", "echo-server.ts");
const tmp = () => mkdtempSync(join(tmpdir(), "dcompose-feat-"));

describe("paginate", () => {
  test("follows cursors until next is empty and flattens items", async () => {
    const pages: Record<string, { items: number[]; next?: string }> = {
      start: { items: [1, 2], next: "p2" },
      p2: { items: [3], next: "p3" },
      p3: { items: [4, 5] },
    };
    const seen: (string | undefined)[] = [];
    const out = await paginate<number, string>(async (cursor) => {
      seen.push(cursor);
      return pages[cursor ?? "start"]!;
    });
    assert.deepEqual(out, [1, 2, 3, 4, 5]);
    assert.deepEqual(seen, [undefined, "p2", "p3"]);
  });
  test("stops on an empty page even if a cursor is returned", async () => {
    const out = await paginate(async (c) => (c ? { items: [], next: "again" } : { items: [1], next: "x" }));
    assert.deepEqual(out, [1]);
  });
  test("maxItems truncates; maxPages is a guardrail", async () => {
    const infinite = async (c: number | undefined) => ({ items: [c ?? 0], next: (c ?? 0) + 1 });
    assert.deepEqual(await paginate(infinite, { maxItems: 3 }), [0, 1, 2]);
    await assert.rejects(
      paginate(infinite, { maxPages: 5 }),
      (e: unknown) => e instanceof GuardrailError && e.reason === "max-pages",
    );
  });
});

describe("oauth provider", () => {
  test("persists client info, tokens and verifier to a per-server file", () => {
    const dir = tmp();
    // Interactive (has onRedirect): the only mode allowed to persist a client registration.
    const p = new FileOAuthProvider({
      server: "my srv",
      serverUrl: "https://x.example/mcp",
      dir,
      redirectUrl: "http://127.0.0.1:1/callback",
      onRedirect: () => {},
    });
    assert.equal(p.path, tokenPath("my srv", "https://x.example/mcp", dir));
    assert.match(p.path, /my_srv-[0-9a-f]{8}\.json$/);
    assert.equal(p.hasTokens, false);
    p.saveClientInformation({ client_id: "abc" });
    p.saveCodeVerifier("v");
    p.saveTokens({ access_token: "t", token_type: "bearer", refresh_token: "r" });
    assert.equal(p.hasTokens, true);

    const again = new FileOAuthProvider({ server: "my srv", serverUrl: "https://x.example/mcp", dir });
    assert.deepEqual(again.clientInformation(), { client_id: "abc" });
    assert.equal(again.codeVerifier(), "v");
    assert.equal(again.tokens()?.refresh_token, "r");
    assert.ok(!existsSync(`${p.path}.${process.pid}.tmp`));
  });
  test("different URLs for the same server name do not share a file", () => {
    const dir = tmp();
    assert.notEqual(tokenPath("s", "https://a.example/mcp", dir), tokenPath("s", "https://b.example/mcp", dir));
  });
  test("non-interactive provider refuses to redirect with a NeedsAuthError", async () => {
    const p = new FileOAuthProvider({ server: "srv", serverUrl: "https://x.example/mcp", dir: tmp() });
    await assert.rejects(
      p.redirectToAuthorization(new URL("https://as.example/authorize")),
      (e: unknown) => e instanceof NeedsAuthError && /dcompose auth srv/.test((e as Error).message),
    );
  });
  test("interactive provider hands the URL to onRedirect; invalidate and reset clear state", async () => {
    const dir = tmp();
    let got: string | null = null;
    const p = new FileOAuthProvider({
      server: "srv",
      serverUrl: "https://x.example/mcp",
      dir,
      redirectUrl: "http://127.0.0.1:1/callback",
      onRedirect: (u) => void (got = u.toString()),
    });
    await p.redirectToAuthorization(new URL("https://as.example/authorize?x=1"));
    assert.equal(got, "https://as.example/authorize?x=1");
    assert.deepEqual(p.clientMetadata.redirect_uris, ["http://127.0.0.1:1/callback"]);
    p.saveTokens({ access_token: "t", token_type: "bearer" });
    p.invalidateCredentials("tokens");
    assert.equal(p.tokens(), undefined);
    p.saveTokens({ access_token: "t2", token_type: "bearer" });
    p.reset();
    assert.ok(!existsSync(p.path));
    assert.equal(p.hasTokens, false);
  });
});

describe("cli: --trace, NO_COLOR, check on a directory", () => {
  let project: string;
  const dc = (args: string[], env: Record<string, string> = {}) =>
    spawnSync(process.execPath, [CLI, ...args], {
      cwd: project,
      encoding: "utf8",
      env: { ...process.env, DCOMPOSE_NO_DAEMON: "1", ...env },
      timeout: 60_000,
      windowsHide: true,
    });

  before(() => {
    project = tmp();
    mkdirSync(join(project, "scripts"));
    writeFileSync(
      join(project, "dcompose.json"),
      JSON.stringify({ mcpServers: { echo: { command: process.execPath, args: [FIXTURE] } } }),
    );
    writeFileSync(
      join(project, "scripts", "ok.ts"),
      'import type { Ctx } from "dcompose";\nexport default async ({ mcp }: Ctx) => mcp.echo.add({ a: 1, b: 2 });\n',
    );
    writeFileSync(
      join(project, "scripts", "bad.ts"),
      'import type { Ctx } from "dcompose";\nexport default async ({ mcp }: Ctx) => mcp.echo.nope({});\n',
    );
  });

  test("--trace streams one NDJSON call record per tool call to stderr", () => {
    const r = dc(["eval", "await mcp.echo.add({a:1,b:1}); await mcp.echo.prose({}); return 1", "-q", "--trace"]);
    assert.equal(r.status, 0, r.stderr);
    const records = r.stderr
      .split("\n")
      .filter((l) => l.startsWith("{"))
      .map((l) => JSON.parse(l));
    assert.deepEqual(
      records.map((x) => [x.kind, x.tool, x.seq]),
      [
        ["call", "add", 1],
        ["call", "prose", 2],
      ],
    );
    assert.ok(records.every((x) => typeof x.ms === "number" && typeof x.resultBytes === "number"));
  });
  test("check accepts a directory and honours NO_COLOR", () => {
    dc(["types"]);
    const r = dc(["check", "scripts"], { NO_COLOR: "1" });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /'nope' does not exist/);
    assert.match(r.stderr, /2 scripts checked/);
    assert.ok(!r.stderr.includes(String.fromCharCode(27) + "["), "expected no ANSI colour codes");
  });
  test("auth refuses stdio servers and reports missing tokens", () => {
    const stdio = dc(["auth", "echo"]);
    assert.equal(stdio.status, 3);
    assert.match(stdio.stderr, /stdio server; it has no OAuth/);

    const dir = tmp();
    writeFileSync(
      join(project, "dcompose.local.json"),
      JSON.stringify({ mcpServers: { remote: { type: "http", url: "https://127.0.0.1:9/mcp" } } }),
    );
    const status = dc(["auth", "remote", "--status"], { DCOMPOSE_AUTH_DIR: dir });
    assert.equal(status.status, 3);
    assert.match(status.stderr, /no tokens stored/);
    assert.ok(!readFileSync(join(project, "dcompose.local.json"), "utf8").includes("token"));
  });
});
