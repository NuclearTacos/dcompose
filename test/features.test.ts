import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { paginate, GuardrailError, unwrap, jsonStringFields } from "../src/runtime/context.ts";
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

describe("unwrap", () => {
  test("parses JSON-in-string fields recursively and leaves text alone", () => {
    const v = unwrap({ result: '{"total":3,"rows":"[1,2]"}', title: "Sensor change {not json", n: 1 });
    assert.deepEqual(v, { result: { total: 3, rows: [1, 2] }, title: "Sensor change {not json", n: 1 });
    assert.deepEqual(unwrap('{"a":1}'), { a: 1 });
    assert.equal(unwrap("plain"), "plain");
    assert.deepEqual(unwrap({ ok: true }), { ok: true });
  });
  test("jsonStringFields names only fields that are embedded JSON", () => {
    assert.deepEqual(jsonStringFields({ result: "[1]", note: "hi", other: "{oops" }), ["result"]);
    assert.deepEqual(jsonStringFields([1, 2]), []);
    assert.deepEqual(jsonStringFields("x"), []);
  });
});

describe("oauth provider: non-interactive refresh path", () => {
  test("always presents a redirect URL so the SDK reaches the refresh branch", () => {
    const dir = tmp();
    const bare = new FileOAuthProvider({ server: "s", serverUrl: "https://x.example/mcp", dir });
    assert.match(bare.redirectUrl, /^http:\/\/127\.0\.0\.1\//);
    // After an interactive sign-in stored a registration, the non-interactive provider reuses its redirect URI.
    const interactive = new FileOAuthProvider({
      server: "s",
      serverUrl: "https://x.example/mcp",
      dir,
      redirectUrl: "http://127.0.0.1:4242/callback",
      onRedirect: () => {},
    });
    interactive.saveClientInformation({ client_id: "c", redirect_uris: ["http://127.0.0.1:4242/callback"] } as never);
    interactive.saveTokens({ access_token: "t", token_type: "bearer", refresh_token: "r" });
    const later = new FileOAuthProvider({ server: "s", serverUrl: "https://x.example/mcp", dir });
    assert.equal(later.redirectUrl, "http://127.0.0.1:4242/callback");
    assert.deepEqual(later.clientInformation(), { client_id: "c", redirect_uris: ["http://127.0.0.1:4242/callback"] });
  });
  test("with nothing stored, clientInformation() fails fast with NeedsAuthError instead of registering", () => {
    const p = new FileOAuthProvider({ server: "srv", serverUrl: "https://x.example/mcp", dir: tmp() });
    assert.throws(
      () => p.clientInformation(),
      (e: unknown) => e instanceof NeedsAuthError,
    );
  });
});

describe("cli: import and init gitignore", () => {
  const run = (args: string[], cwd: string, env: Record<string, string> = {}) =>
    spawnSync(process.execPath, [CLI, ...args], {
      cwd,
      encoding: "utf8",
      env: { ...process.env, DCOMPOSE_NO_DAEMON: "1", ...env },
      timeout: 60_000,
      windowsHide: true,
    });

  test("import --list exits 0; importing an unknown name exits 3 and names the known ones", () => {
    const dir = tmp();
    assert.equal(run(["import", "--list"], dir).status, 0);
    const r = run(["import", "definitely-not-a-server-xyz"], dir);
    assert.equal(r.status, 3);
    assert.match(r.stderr, /not found in Claude Code config/);
    assert.ok(!existsSync(join(dir, "dcompose.local.json")), "must not write into the directory");
  });

  test("init --import-claude inside a git repo adds real ignore rules and reports truthfully", () => {
    const repo = tmp();
    spawnSync("git", ["init", "-q"], { cwd: repo, windowsHide: true });
    writeFileSync(join(repo, ".gitignore"), "node_modules/\n");
    const r = run(["init", "--import-claude", "--no-skill"], repo);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /added dcompose\.local\.json, \.dcompose\/ to \.gitignore|already gitignored/);
    const gi = readFileSync(join(repo, ".gitignore"), "utf8");
    assert.match(gi, /dcompose\.local\.json/);
    assert.match(gi, /\.dcompose\//);
    const ignored = spawnSync("git", ["check-ignore", "-q", "dcompose.local.json"], { cwd: repo, windowsHide: true });
    assert.equal(ignored.status, 0, "dcompose.local.json must actually be ignored");
    assert.match(r.stderr, /prefer `dcompose import --user`/);
  });

  test("init outside a git repo says so instead of claiming gitignored", () => {
    const dir = tmp();
    const r = run(["init", "--import-claude", "--no-skill"], dir, { GIT_CEILING_DIRECTORIES: dir });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /not a git repo|added .* to \.gitignore|already gitignored/);
  });
});

describe("cli: one broken server does not fail servers/types; new scaffolds; run echoes path", () => {
  let project: string;
  const run = (args: string[], env: Record<string, string> = {}) =>
    spawnSync(process.execPath, [CLI, ...args], {
      cwd: project,
      encoding: "utf8",
      env: { ...process.env, DCOMPOSE_NO_DAEMON: "1", ...env },
      timeout: 60_000,
      windowsHide: true,
    });

  before(() => {
    project = tmp();
    writeFileSync(
      join(project, "dcompose.json"),
      JSON.stringify({
        mcpServers: {
          echo: { command: process.execPath, args: [FIXTURE] },
          broken: { command: "definitely-not-a-real-binary-xyz" },
        },
        defaults: { connectTimeoutMs: 20_000 },
      }),
    );
  });

  test("servers: exit 0 with a warning when one server fails, exit 3 with --strict", () => {
    const r = run(["servers"]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /echo\s+stdio\s+connected/);
    assert.match(r.stdout, /broken\s+stdio\s+error/);
    assert.match(r.stderr, /1 of 2 servers failed to connect \(exit 0/);
    assert.equal(run(["servers", "--strict"]).status, 3);
  });

  test("types: written for the working servers, exit 0, --strict exits 3", () => {
    const r = run(["types", "--force"]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /wrote .*mcp\.d\.ts: 1 server/);
    assert.match(r.stderr, /1 server failed to connect/);
    assert.match(readFileSync(join(project, ".dcompose", "types", "mcp.d.ts"), "utf8"), /echo: Echo;/);
    assert.equal(run(["types", "--force", "--strict"]).status, 3);
  });

  test("new scaffolds a default-export script at the scripts path and prints it; check passes on it", () => {
    const r = run(["new", "digest"]);
    assert.equal(r.status, 0, r.stderr);
    const path = r.stdout.trim();
    assert.ok(existsSync(path), path);
    assert.match(
      readFileSync(path, "utf8"),
      /export default async function \(\{ mcp, pmap, paginate, unwrap, input, log \}: Ctx<Input>\)/,
    );
    assert.equal(run(["new", "digest"]).status, 3, "refuses to overwrite without --force");
    assert.equal(run(["new", "digest", "--force"]).status, 0);
    assert.equal(run(["new", "../escape"]).status, 3);
    const chk = run(["check", "digest"]);
    assert.equal(chk.status, 0, chk.stderr);
    assert.match(chk.stderr, /checking .*digest\.ts/);
    const stream = run(["new", "feed", "--stream"]);
    assert.match(readFileSync(stream.stdout.trim(), "utf8"), /export default async function\* /);
  });

  test("tools notes when a server annotates some tools read-only; call notes plain and prefixed text", () => {
    const t = run(["tools", "echo"]);
    assert.equal(t.status, 0, t.stderr);
    assert.match(t.stderr, /note: \d+ of \d+ tools are annotated read-only; --read-only refuses the other \d+/);

    const plain = run(["call", "echo.prose"]);
    assert.match(plain.stderr, /result is plain text, not JSON/);

    const prefixed = run(["call", "echo.prefixed"]);
    assert.equal(prefixed.status, 0, prefixed.stderr);
    assert.match(prefixed.stderr, /text with JSON after a prefix/);
    assert.match(prefixed.stdout, /^"\[fixture\] 2 builds/);

    const json = run(["call", "echo.add", '{"a":1,"b":2}']);
    assert.doesNotMatch(json.stderr, /note:/);
  });

  test("run header echoes the resolved script path", () => {
    const r = run(["run", "digest", "--allow", "none.*"]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /\[dcompose\] run \S+ · script .*digest\.ts/);
    assert.deepEqual(JSON.parse(r.stdout), { todo: true });
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
  test("where reports project mode here and workspace mode in a bare directory", () => {
    const here = JSON.parse(dc(["where", "--json"]).stdout);
    assert.equal(here.mode, "project");
    assert.equal(here.root.toLowerCase(), project.toLowerCase());
    assert.match(here.scripts, /scripts$/);

    const bare = tmp();
    const r = spawnSync(process.execPath, [CLI, "where", "--json"], {
      cwd: bare,
      encoding: "utf8",
      env: { ...process.env, DCOMPOSE_NO_DAEMON: "1" },
      windowsHide: true,
    });
    const w = JSON.parse(r.stdout);
    assert.equal(w.mode, "workspace");
    assert.ok(
      !w.root.toLowerCase().startsWith(bare.toLowerCase()),
      "workspace root must not be inside the bare directory",
    );
    assert.ok(w.root.replace(/\\/g, "/").includes("/workspaces/"));
  });
  test("skill --dir writes the three files and respects existing ones without --force", () => {
    const dir = join(tmp(), "skills", "dcompose");
    const first = dc(["skill", "--dir", dir]);
    assert.equal(first.status, 0, first.stderr);
    for (const f of ["SKILL.md", "patterns.md", "pitfalls.md"]) assert.ok(existsSync(join(dir, f)), f);
    writeFileSync(join(dir, "SKILL.md"), "custom");
    dc(["skill", "--dir", dir]);
    assert.equal(readFileSync(join(dir, "SKILL.md"), "utf8"), "custom");
    dc(["skill", "--dir", dir, "--force"]);
    assert.match(readFileSync(join(dir, "SKILL.md"), "utf8"), /^---\nname: dcompose/);
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
