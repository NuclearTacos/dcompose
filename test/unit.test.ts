import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseResult, tryJson, ToolError } from "../src/result.ts";
import { expandEnv, parseDuration, loadConfig, findProjectRoot, ConfigError } from "../src/config.ts";
import { parseBytes } from "../src/commands/run.ts";
import { pmap } from "../src/runtime/pmap.ts";
import { ulid, runId } from "../src/runtime/ulid.ts";
import { openStore } from "../src/runtime/store.ts";
import { makeAllow } from "../src/runner.ts";
import { generateTypes, toolsHash, readHash } from "../src/typegen.ts";
import { table, firstLine } from "../src/output.ts";
import type { ToolInfo } from "../src/client.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "dcompose-test-"));
// Isolate from the developer's real ~/.dcompose/config.json so the merge tests see only their own files.
process.env.DCOMPOSE_HOME = tmp();

describe("result parsing", () => {
  test("structuredContent wins over text", () => {
    assert.deepEqual(parseResult({ content: [{ type: "text", text: '{"a":1}' }], structuredContent: { b: 2 } }), {
      b: 2,
    });
  });
  test("single JSON text block becomes a value", () => {
    assert.deepEqual(parseResult({ content: [{ type: "text", text: '{"a":[1,2]}' }] }), { a: [1, 2] });
  });
  test("prose stays a string", () => {
    assert.equal(parseResult({ content: [{ type: "text", text: "hello there" }] }), "hello there");
  });
  test("multiple blocks become an array; empty becomes null", () => {
    assert.deepEqual(
      parseResult({
        content: [
          { type: "text", text: "1" },
          { type: "text", text: "x" },
        ],
      }),
      [1, "x"],
    );
    assert.equal(parseResult({ content: [] }), null);
  });
  test("image blocks are summarised, not inlined", () => {
    const r = parseResult({ content: [{ type: "image", data: "AAAA", mimeType: "image/png" }] }) as {
      type: string;
      bytes: number;
    };
    assert.equal(r.type, "image");
    assert.equal(r.bytes, 3);
  });
  test("tryJson does not parse near-misses", () => {
    assert.equal(tryJson("  {oops"), "  {oops");
    assert.equal(tryJson("true"), true);
    assert.equal(tryJson("-3.5"), -3.5);
    assert.equal(tryJson(""), "");
  });
  test("ToolError carries server, tool and truncated text", () => {
    const e = new ToolError("srv", "t", { content: [{ type: "text", text: "boom" }], isError: true });
    assert.match(e.message, /srv\.t returned an error: boom/);
    assert.equal(e.server, "srv");
  });
});

describe("config", () => {
  test("expandEnv handles ${VAR} and ${VAR:-default} recursively", () => {
    const out = expandEnv({ a: "x-${FOO}-y", b: ["${BAR:-dflt}", "${MISSING}"], c: 3 }, { FOO: "1" });
    assert.deepEqual(out, { a: "x-1-y", b: ["dflt", ""], c: 3 });
  });
  test("parseDuration accepts units and bare ms", () => {
    assert.equal(parseDuration("500ms"), 500);
    assert.equal(parseDuration("2s"), 2000);
    assert.equal(parseDuration("1.5m"), 90_000);
    assert.equal(parseDuration("1h"), 3_600_000);
    assert.equal(parseDuration("250"), 250);
    assert.equal(parseDuration(0), 0);
    assert.throws(() => parseDuration("soon"), ConfigError);
  });
  test("parseBytes accepts k/m/g suffixes", () => {
    assert.equal(parseBytes("64k"), 65536);
    assert.equal(parseBytes("1m"), 1048576);
    assert.equal(parseBytes("512"), 512);
    assert.equal(parseBytes("0"), 0);
    assert.throws(() => parseBytes("lots"));
  });
  test("loadConfig merges project then local, later wins per server", () => {
    const dir = tmp();
    writeFileSync(
      join(dir, "dcompose.json"),
      JSON.stringify({ mcpServers: { a: { command: "a1" }, b: { command: "b1" } }, defaults: { maxCalls: 7 } }),
    );
    writeFileSync(
      join(dir, "dcompose.local.json"),
      JSON.stringify({ mcpServers: { b: { command: "b2", env: { T: "${T_VAL:-z}" } } } }),
    );
    const { config, sources } = loadConfig({ cwd: dir });
    assert.equal(sources.length, 2);
    assert.equal((config.mcpServers.a as { command: string }).command, "a1");
    assert.equal((config.mcpServers.b as { command: string }).command, "b2");
    assert.equal((config.mcpServers.b as { env: Record<string, string> }).env.T, "z");
    assert.equal(config.defaults.maxCalls, 7);
    assert.equal(config.defaults.timeout, "5m"); // default filled in
    assert.equal(config.daemon.autoStart, false);
  });
  test("explicit path that does not exist is a ConfigError", () => {
    assert.throws(() => loadConfig({ explicitPath: join(tmp(), "nope.json") }), ConfigError);
  });
  test("invalid server shape is reported with a path", () => {
    const dir = tmp();
    writeFileSync(join(dir, "dcompose.json"), JSON.stringify({ mcpServers: { bad: { type: "http" } } }));
    assert.throws(() => loadConfig({ cwd: dir }), /mcpServers\.bad/);
  });
  test("findProjectRoot walks up to the nearest config", () => {
    const root = tmp();
    writeFileSync(join(root, "dcompose.json"), "{}");
    const deep = join(root, "a", "b");
    mkdirSync(deep, { recursive: true });
    assert.equal(findProjectRoot(deep), root);
    // No config anywhere up the tree: never use the directory itself (it may be someone else's
    // repo); use a per-directory workspace under ~/.dcompose instead.
    const lonely = tmp();
    const ws = findProjectRoot(lonely);
    assert.notEqual(ws, lonely);
    // Lives under DCOMPOSE_HOME (a temp dir here; ~/.dcompose in real use), never under `lonely`.
    assert.match(ws.replace(/\\/g, "/"), /\/workspaces\/[0-9a-f]{12}$/);
    assert.ok(ws.replace(/\\/g, "/").startsWith(process.env.DCOMPOSE_HOME!.replace(/\\/g, "/")));
    assert.equal(findProjectRoot(lonely), ws, "stable for the same directory");
    // Running from inside that workspace (e.g. its scripts folder) must resolve to the same
    // workspace, not spawn a nested one. A real session hit "script not found" this way.
    const scripts = join(ws, ".dcompose", "scripts");
    mkdirSync(scripts, { recursive: true });
    assert.equal(findProjectRoot(scripts), ws);
    // But dcompose's own home (which has a `.dcompose`-named parent when it *is* ~/.dcompose) is not a root:
    // a directory whose only `.dcompose` child is dcompose's home still gets a workspace.
    const fakeHomeParent = tmp();
    const fakeHome = join(fakeHomeParent, ".dcompose");
    mkdirSync(fakeHome, { recursive: true });
    const prev = process.env.DCOMPOSE_HOME;
    process.env.DCOMPOSE_HOME = fakeHome;
    try {
      const r = findProjectRoot(fakeHomeParent);
      assert.notEqual(r, fakeHomeParent);
      assert.ok(r.replace(/\\/g, "/").includes("/workspaces/"));
    } finally {
      process.env.DCOMPOSE_HOME = prev;
    }
  });
});

describe("pmap", () => {
  test("preserves order under concurrency", async () => {
    const out = await pmap(
      [30, 10, 20],
      async (ms) => {
        await new Promise((r) => setTimeout(r, ms));
        return ms;
      },
      { concurrency: 3 },
    );
    assert.deepEqual(out, [30, 10, 20]);
  });
  test("never exceeds the concurrency limit", async () => {
    let active = 0;
    let peak = 0;
    await pmap(
      Array.from({ length: 20 }, (_, i) => i),
      async () => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 5));
        active--;
      },
      { concurrency: 4 },
    );
    assert.equal(peak, 4);
  });
  test("rejects on first failure by default, settles when asked", async () => {
    await assert.rejects(
      pmap([1, 2, 3], async (n) => {
        if (n === 2) throw new Error("two");
        return n;
      }),
      /two/,
    );
    const settled = await pmap(
      [1, 2, 3],
      async (n) => {
        if (n === 2) throw new Error("two");
        return n;
      },
      { settle: true },
    );
    assert.deepEqual(settled, [1, { error: "two" }, 3]);
  });
  test("empty input", async () => {
    assert.deepEqual(await pmap([], async (x) => x), []);
  });
});

describe("ids", () => {
  test("ulid is 26 Crockford chars and time-sortable", () => {
    const a = ulid(1000);
    const b = ulid(2000);
    assert.match(a, /^[0-9A-HJKMNP-TV-Z]{26}$/);
    assert.ok(a < b);
  });
  test("runId has a readable UTC prefix", () => {
    const id = runId(new Date("2026-09-11T14:02:11.123Z"));
    assert.match(id, /^20260911T140211Z-[0-9A-HJKMNP-TV-Z]{26}$/);
  });
  test("runIds are unique across rapid calls", () => {
    const ids = new Set(Array.from({ length: 500 }, () => runId()));
    assert.equal(ids.size, 500);
  });
});

describe("store", () => {
  test("round-trips values and persists to disk atomically", async () => {
    const dir = tmp();
    const s = openStore(dir, "my script!");
    assert.equal(await s.get("k"), undefined);
    await s.set("k", { n: 1 });
    assert.deepEqual(await s.get("k"), { n: 1 });
    assert.ok(existsSync(s.path));
    assert.match(s.path, /my_script_\.json$/);
    assert.ok(!existsSync(`${s.path}.${process.pid}.tmp`));
    const again = openStore(dir, "my script!");
    assert.deepEqual(await again.all(), { k: { n: 1 } });
    await again.delete("k");
    assert.deepEqual(JSON.parse(readFileSync(s.path, "utf8")), {});
  });
  test("corrupt file is a clear error", async () => {
    const dir = tmp();
    writeFileSync(join(dir, "bad.json"), "{nope");
    await assert.rejects(openStore(dir, "bad").get("x"), /corrupt/);
  });
});

describe("allow list", () => {
  test("undefined when nothing configured", () => {
    assert.equal(makeAllow(undefined, undefined), undefined);
    assert.equal(makeAllow([], []), undefined);
  });
  test("globs match server.tool; deny beats allow", () => {
    const f = makeAllow(["pd.list_*", "pd.get_incident"], ["pd.list_secret*"])!;
    assert.equal(f("pd.list_incidents"), true);
    assert.equal(f("pd.get_incident"), true);
    assert.equal(f("pd.get_incidents"), false);
    assert.equal(f("pd.list_secret_things"), false);
    assert.equal(f("other.list_x"), false);
  });
  test("deny-only allows everything else", () => {
    const f = makeAllow(undefined, ["*.delete_*"])!;
    assert.equal(f("a.delete_x"), false);
    assert.equal(f("a.get_x"), true);
  });
  test("regex metacharacters in names are literal", () => {
    const f = makeAllow(["s.a+b"], undefined)!;
    assert.equal(f("s.a+b"), true);
    assert.equal(f("s.aab"), false);
  });
});

describe("type generation", () => {
  const tool = (server: string, name: string, extra: Partial<ToolInfo> = {}): ToolInfo =>
    ({
      server,
      name,
      readOnly: true,
      inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
      ...extra,
    }) as ToolInfo;

  test("emits an augmentation and pins requested names", async () => {
    const src = await generateTypes(new Map([["pager-duty", [tool("pager-duty", "get_thing")]]]));
    assert.match(src, /declare module "dcompose"/);
    assert.match(src, /"pager-duty": PagerDuty;/);
    assert.match(src, /export interface PagerDuty_get_thing_Input/);
    assert.match(src, /get_thing\(args: PagerDuty_get_thing_Input\): Promise<any>;/);
    assert.match(src, /@returns any/);
  });
  test("every referenced type is declared exactly once, hoisted $defs prefixed per tool", async () => {
    const out = {
      type: "object",
      properties: { svc: { $ref: "#/$defs/Ref" } },
      $defs: { Ref: { type: "object", properties: { id: { type: "string" } } } },
    };
    const src = await generateTypes(
      new Map([["s", [tool("s", "a", { outputSchema: out }), tool("s", "b", { outputSchema: out })]]]),
    );
    const decls = [...src.matchAll(/^export (?:interface|type) ([\w$]+)/gm)].map((m) => m[1]);
    assert.equal(decls.length, new Set(decls).size, `duplicate declarations: ${decls.join(",")}`);
    assert.ok(decls.includes("S_a_Output_Ref"));
    assert.ok(decls.includes("S_b_Output_Ref"));
    const refs = [...src.matchAll(/: ([A-Z][\w$]*_(?:Input|Output)(?:_[\w$]+)?)\b/g)].map((m) => m[1]);
    for (const r of refs) assert.ok(decls.includes(r), `undeclared reference ${r}`);
  });
  test("inputs are closed, outputs are open with any extras", async () => {
    const src = await generateTypes(
      new Map([["s", [tool("s", "t", { outputSchema: { type: "object", properties: { x: { type: "number" } } } })]]]),
    );
    const input = src.slice(src.indexOf("export interface S_t_Input"), src.indexOf("export interface S_t_Output"));
    const output = src.slice(src.indexOf("export interface S_t_Output"));
    assert.doesNotMatch(input, /\[k: string\]/);
    assert.match(output, /\[k: string\]: any/);
  });
  test("optional args when nothing is required; quoted keys for odd names", async () => {
    const src = await generateTypes(
      new Map([
        ["s", [tool("s", "odd-name", { inputSchema: { type: "object", properties: { q: { type: "string" } } } })]],
      ]),
    );
    assert.match(src, /"odd-name"\(args\?: S_odd_name_Input\)/);
  });
  test("hash is stable and readable back", async () => {
    const m = new Map([["s", [tool("s", "t")]]]);
    const h1 = toolsHash(m);
    const src = await generateTypes(m);
    assert.equal(readHash(src), h1);
    assert.equal(toolsHash(new Map([["s", [tool("s", "t", { description: "irrelevant to hash" })]]])), h1);
    assert.notEqual(toolsHash(new Map([["s", [tool("s", "u")]]])), h1);
  });
});

describe("output helpers", () => {
  test("table pads and truncates", () => {
    const t = table(
      [
        ["NAME", "DESC"],
        ["a", "a very long description indeed"],
      ],
      { maxWidth: [10, 12] },
    );
    const lines = t.split("\n");
    assert.equal(lines[0], "NAME  DESC");
    assert.match(lines[1]!, /^a\s+a very long…$/);
  });
  test("firstLine trims", () => {
    assert.equal(firstLine("  hello \nworld"), "hello");
    assert.equal(firstLine(undefined), "");
  });
});
