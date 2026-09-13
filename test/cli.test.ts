// Integration: drive the real CLI against test/fixtures/echo-server.ts (a stdio MCP server).
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
// Isolate from the developer's real ~/.dcompose (user config, auth tokens, daemon records).
process.env.DCOMPOSE_HOME = mkdtempSync(join(tmpdir(), "dcompose-home-"));
const CLI = join(ROOT, "src", "cli.ts");
const FIXTURE = join(ROOT, "test", "fixtures", "echo-server.ts");

interface Result {
  code: number;
  out: string;
  err: string;
  json: () => unknown;
}

let project: string;

function dc(args: string[], opts: { input?: string; cwd?: string; env?: Record<string, string> } = {}): Result {
  const r: SpawnSyncReturns<string> = spawnSync(process.execPath, [CLI, ...args], {
    cwd: opts.cwd ?? project,
    input: opts.input,
    encoding: "utf8",
    env: { ...process.env, DCOMPOSE_NO_DAEMON: opts.env?.DCOMPOSE_NO_DAEMON ?? "1", ...opts.env },
    timeout: 60_000,
    windowsHide: true,
  });
  return { code: r.status ?? -1, out: r.stdout, err: r.stderr, json: () => JSON.parse(r.stdout) };
}

function script(name: string, body: string): string {
  const p = join(project, ".dcompose", "scripts", `${name}.ts`);
  writeFileSync(p, body);
  return name;
}

before(() => {
  project = mkdtempSync(join(tmpdir(), "dcompose-it-"));
  mkdirSync(join(project, ".dcompose", "scripts"), { recursive: true });
  writeFileSync(
    join(project, "dcompose.json"),
    JSON.stringify({
      mcpServers: { echo: { command: process.execPath, args: [FIXTURE] } },
      defaults: { maxCalls: 50, timeout: "30s", concurrency: 3, connectTimeoutMs: 20_000 },
    }),
  );
});

describe("servers / tools", () => {
  test("servers connects and counts tools", () => {
    const r = dc(["servers", "--json"]);
    assert.equal(r.code, 0, r.err);
    const rows = r.json() as { name: string; status: string; tools: number }[];
    assert.equal(rows[0]!.name, "echo");
    assert.equal(rows[0]!.status, "connected");
    assert.equal(rows[0]!.tools, 8);
  });
  test("tools lists read-only markers and supports grep", () => {
    const r = dc(["tools", "echo", "--grep", "write"]);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /echo\.write_thing/);
    assert.doesNotMatch(r.out, /\[read-only\]/);
    const ro = dc(["tools", "echo", "--grep", "add"]);
    assert.match(ro.out, /\[read-only\]/);
  });
  test("unknown server exits 3 with the known list", () => {
    const r = dc(["tools", "nope"]);
    assert.equal(r.code, 3);
    assert.match(r.err, /unknown server\. Known: echo/);
  });
});

describe("call", () => {
  test("structuredContent is returned as-is, compact when piped", () => {
    const r = dc(["call", "echo.echo", '{"value":{"a":[1,2]}}']);
    assert.equal(r.code, 0, r.err);
    assert.equal(r.out, '{"value":{"a":[1,2]}}\n');
  });
  test("JSON text is parsed; prose is a string; -r prints it bare", () => {
    assert.deepEqual(dc(["call", "echo.add", '{"a":2,"b":3}']).json(), { sum: 5 });
    assert.equal(dc(["call", "echo.prose"]).out, '"just some words"\n');
    assert.equal(dc(["call", "echo.prose", "-r"]).out, "just some words\n");
  });
  test("--raw returns the envelope", () => {
    const env = dc(["call", "echo.add", '{"a":1,"b":1}', "--raw"]).json() as { content: unknown[] };
    assert.ok(Array.isArray(env.content));
  });
  test("args from stdin with -", () => {
    const r = dc(["call", "echo.add", "-"], { input: '{"a":10,"b":5}' });
    assert.deepEqual(r.json(), { sum: 15 });
  });
  test("tool error exits 1 with the message; bad JSON args exits 1", () => {
    const r = dc(["call", "echo.fail", '{"message":"nope"}']);
    assert.equal(r.code, 1);
    assert.match(r.err, /echo\.fail returned an error: nope/);
    assert.equal(dc(["call", "echo.add", "{bad"]).code, 1);
  });
  test("--read-only refuses unannotated tools with exit 2", () => {
    const r = dc(["call", "echo.write_thing", "--read-only"]);
    assert.equal(r.code, 2);
    assert.match(r.err, /not marked readOnlyHint/);
    assert.equal(dc(["call", "echo.add", '{"a":1,"b":1}', "--read-only"]).code, 0);
  });
  test("--each maps NDJSON stdin in order and reports failures", () => {
    const r = dc(["call", "echo.add", '{"b":100}', "--each", "--concurrency", "2"], {
      input: '{"a":1}\n{"a":2}\nnot json\n{"a":3}\n',
    });
    assert.equal(r.code, 1);
    const lines = r.out
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    assert.deepEqual(lines[0], { sum: 101 });
    assert.deepEqual(lines[1], { sum: 102 });
    assert.match((lines[2] as { error: string }).error, /line 3/);
    assert.deepEqual(lines[3], { sum: 103 });
    assert.match(r.err, /1 of 4 calls failed/);
  });
});

describe("run / eval", () => {
  test("scenario 1: list, filter, fan out, return only what matters", () => {
    const name = script(
      "fanout",
      `export default async function ({ mcp, pmap, input }) {
        const items = await mcp.echo.list({ n: input.n });
        const active = items.filter((i) => i.active);
        const sums = await pmap(active, async (i, idx) => (await mcp.echo.add({ a: idx, b: 1 })).sum, { concurrency: 3 });
        return { total: items.length, active: active.length, sums };
      }`,
    );
    const r = dc(["run", name, "-i", '{"n":10}', "--read-only", "-q"]);
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(r.json(), { total: 10, active: 5, sums: [1, 2, 3, 4, 5] });
  });
  test("trace file has header, one call line per tool call, and a summary", () => {
    dc([
      "eval",
      "await mcp.echo.add({a:1,b:1}); await mcp.echo.add({a:2,b:2}); return 1",
      "-q",
      "--label",
      "trace-test",
    ]);
    const runsDir = join(project, ".dcompose", "runs");
    const latest = readdirSync(runsDir)
      .filter((f) => f.endsWith(".jsonl"))
      .sort()
      .at(-1)!;
    assert.match(latest, /^\d{8}T\d{6}Z-[0-9A-Z]{26}\.jsonl$/);
    const lines = readFileSync(join(runsDir, latest), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    assert.equal(lines[0].kind, "run");
    assert.equal(lines[0].label, "trace-test");
    assert.equal(lines.filter((l) => l.kind === "call").length, 2);
    const summary = lines.at(-1);
    assert.equal(summary.kind, "summary");
    assert.equal(summary.calls, 2);
    assert.equal(summary.exitCode, 0);
  });
  test("eval: expression form, body form, stdin lines, input from stdin", () => {
    assert.equal(dc(["eval", "1 + 1", "-q"]).out, "2\n");
    assert.equal(dc(["eval", "const r = await mcp.echo.add({a:2,b:2}); return r.sum", "-q"]).out, "4\n");
    assert.equal(dc(["eval", "await Array.fromAsync(stdin.lines())", "-q"], { input: "a\n\nb\n" }).out, '["a","b"]\n');
    assert.equal(dc(["eval", "input.x", "-q", "-i", "-"], { input: '{"x":42}' }).out, "42\n");
  });
  test("--jsonl and -r shape output", () => {
    assert.equal(dc(["eval", '["a","b"]', "-q", "--jsonl", "-r"]).out, "a\nb\n");
  });
  test("guardrails exit 2 with the reason", () => {
    const budget = dc([
      "eval",
      "for (let i=0;i<5;i++) await mcp.echo.add({a:i,b:i}); return 1",
      "-q",
      "--max-calls",
      "2",
    ]);
    assert.equal(budget.code, 2);
    assert.match(budget.err, /call budget exhausted \(2\)/);

    const denied = dc(["eval", "await mcp.echo.add({a:1,b:1})", "-q", "--deny", "echo.add"]);
    assert.equal(denied.code, 2);
    assert.match(denied.err, /not in the allow list/);

    const ro = dc(["eval", "await mcp.echo.write_thing({})", "-q", "--read-only"]);
    assert.equal(ro.code, 2);

    const timeout = dc(["eval", "await sleep(2000); return 1", "-q", "--timeout", "300ms"]);
    assert.equal(timeout.code, 2);
    assert.match(timeout.err, /exceeded --timeout/);

    const cap = dc(["eval", '"x".repeat(500)', "-q", "--max-output-bytes", "100"]);
    assert.equal(cap.code, 2);
    const stub = cap.json() as { $dcompose: string; file: string; bytes: number };
    assert.equal(stub.$dcompose, "output-truncated");
    assert.ok(existsSync(stub.file));

    const exec = dc(["eval", 'await sh("echo hi")', "-q"]);
    assert.equal(exec.code, 2);
    assert.match(exec.err, /requires --allow-exec/);
  });
  test("--allow-exec runs a shell command and traces it as $sh", () => {
    const r = dc(["eval", '(await sh("echo hi")).stdout.trim()', "-q", "--allow-exec", "-r"]);
    assert.equal(r.code, 0, r.err);
    assert.equal(r.out, "hi\n");
  });
  test("--dry-run executes nothing and returns null per call", () => {
    const r = dc(["eval", "await mcp.echo.fail({})", "-q", "--dry-run"]);
    assert.equal(r.code, 0, r.err);
    assert.equal(r.out, "null\n");
    assert.match(r.err, /\[dry-run\] echo\.fail/);
  });
  test("script error exits 1 and shows the user's frame only", () => {
    const name = script("bad", "export default async function () {\n  const x = null;\n  return x.boom;\n}");
    const r = dc(["run", name, "-q"]);
    assert.equal(r.code, 1);
    assert.match(r.err, /TypeError: Cannot read properties of null/);
    assert.match(r.err, /bad\.ts:3/);
    assert.doesNotMatch(r.err, /node_modules|src[\\/]runner/);
  });
  test("missing script exits 1 with the search locations", () => {
    const r = dc(["run", "does-not-exist", "-q"]);
    assert.equal(r.code, 1);
    assert.match(r.err, /script not found/);
  });
  test("store persists across runs and honours --state", () => {
    const name = script(
      "counter",
      'export default async ({ store }) => { const n = ((await store.get("n")) ?? 0) + 1; await store.set("n", n); return n; }',
    );
    assert.equal(dc(["run", name, "-q"]).out, "1\n");
    assert.equal(dc(["run", name, "-q"]).out, "2\n");
    assert.equal(dc(["run", name, "-q", "--state", "other"]).out, "1\n");
    assert.ok(existsSync(join(project, ".dcompose", "state", "counter.json")));
  });
  test("async generator scripts stream one NDJSON line per yield", () => {
    const name = script(
      "gen",
      "export default async function* ({ mcp }) { for (let i = 0; i < 3; i++) yield await mcp.echo.add({ a: i, b: 0 }); }",
    );
    const r = dc(["run", name, "-q"]);
    assert.equal(r.code, 0, r.err);
    assert.equal(r.out, '{"sum":0}\n{"sum":1}\n{"sum":2}\n');
  });
  test("emit goes to stderr, never stdout", () => {
    const r = dc(["eval", 'emit({ k: 1 }); return "done"', "-q"]);
    assert.equal(r.out, '"done"\n');
    assert.match(r.err, /\{"k":1\}/);
  });
});

describe("types / check / runs", () => {
  test("types writes a d.ts with the augmentation and is cached by hash", () => {
    const r = dc(["types"]);
    assert.equal(r.code, 0, r.err);
    const p = join(project, ".dcompose", "types", "mcp.d.ts");
    const src = readFileSync(p, "utf8");
    assert.match(src, /interface McpServers \{\s+echo: Echo;/);
    assert.match(src, /add\(args: Echo_add_Input\): Promise<any>;/);
    assert.match(dc(["types"]).err, /up to date/);
  });
  test("check catches a wrong tool name and a wrong argument", () => {
    script(
      "typo",
      'import type { Ctx } from "dcompose";\nexport default async function ({ mcp }: Ctx) {\n  await mcp.echo.ad({ a: 1, b: 2 });\n  return mcp.echo.add({ a: 1, c: 2 });\n}\n',
    );
    const r = dc(["check", "typo", "--json"]);
    assert.equal(r.code, 1);
    const diags = r.json() as { message: string }[];
    assert.ok(
      diags.some((d) => /'ad' does not exist/.test(d.message)),
      JSON.stringify(diags),
    );
    assert.ok(
      diags.some((d) => /'c' does not exist/.test(d.message)),
      JSON.stringify(diags),
    );
  });
  test("runs lists and shows the trace of a labelled run", () => {
    const list = dc(["runs", "--label", "trace-test", "--json"]).json() as { label: string; calls: number }[];
    assert.equal(list[0]!.label, "trace-test");
    assert.equal(list[0]!.calls, 2);
    const show = dc(["runs", "show", "--label", "trace-test", "--json"]).json() as { calls: { tool: string }[] };
    assert.deepEqual(
      show.calls.map((c) => c.tool),
      ["add", "add"],
    );
  });
});

describe("daemon", () => {
  after(() => {
    dc(["daemon", "stop"], { env: { DCOMPOSE_NO_DAEMON: "" } });
  });
  test("start, route a call through it, status, stop", () => {
    const env = { DCOMPOSE_NO_DAEMON: "" };
    const start = dc(["daemon", "start"], { env });
    assert.equal(start.code, 0, start.err);
    assert.match(start.err, /daemon ready/);

    const via = dc(["-v", "eval", "(await mcp.echo.add({a:20,b:22})).sum", "-q"], { env });
    assert.equal(via.code, 0, via.err);
    assert.equal(via.out, "42\n");
    assert.match(via.err, /using daemon/);

    const status = dc(["daemon", "status", "--json"], { env }).json() as {
      running: boolean;
      servers: { name: string; connected: boolean }[];
    };
    assert.equal(status.running, true);
    assert.equal(status.servers[0]!.connected, true);

    const err = dc(["call", "echo.fail", '{"message":"via-daemon"}'], { env });
    assert.equal(err.code, 1);
    assert.match(err.err, /via-daemon/);

    const stop = dc(["daemon", "stop"], { env });
    assert.equal(stop.code, 0, stop.err);
    assert.equal(dc(["daemon", "status"], { env }).code, 3);
    assert.ok(!existsSync(join(project, ".dcompose", "daemon.json")));
  });
});
