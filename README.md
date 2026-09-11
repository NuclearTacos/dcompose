# dcompose

Compose MCP tool calls in code instead of one tool call per model round-trip. A local CLI a
coding agent drives through its shell. See [DESIGN.md](DESIGN.md) for the why and
[EXAMPLES.md](EXAMPLES.md) for the target usage.

**Status: phase 4.** `init`, `servers`, `tools`, `call` (with `--each`), `run`, `eval`, `types`,
`check`, and `runs` work against stdio and HTTP servers, with run traces, guardrails, generated
TypeScript signatures, a persisted per-script `store`, streaming via async generators, opt-in
`sh()`, and a SKILL.md that teaches Claude Code the workflow. The warm-connection daemon and
OAuth for remote servers are not built yet.

## Quickstart

Requires Node ≥ 22.18 (native TypeScript stripping).

```sh
npm install
npm run build
npm link                       # puts `dcompose` on PATH, or use `node bin/dcompose.js`

dcompose init --import-claude  # seed dcompose.local.json from ~/.claude.json and ./.mcp.json
dcompose servers               # connect to everything, show tool counts
dcompose tools pagerduty --grep incident
dcompose call pagerduty.list_incidents '{"statuses":["triggered"],"limit":3}' | jq '.response[].title'
```

During development, `node src/cli.ts ...` runs the TypeScript directly with no build step.

## Scripts

A script is a module whose default export takes a context and returns the value to print:

```ts
// .dcompose/scripts/recent-incidents.ts
import type { Ctx } from "dcompose";

export default async function ({ mcp, pmap, input }: Ctx<{ limit?: number }>) {
  const { response } = await mcp.pagerduty.list_incidents({ statuses: ["resolved"], limit: input.limit ?? 5 });
  return pmap(response, async (i) => {
    const notes = await mcp.pagerduty.list_incident_notes({ incident_id: i.id });
    return { id: i.id, title: i.title, notes: notes.response.length };
  }, { concurrency: 4 });
}
```

```sh
dcompose run recent-incidents -i '{"limit":3}' --jsonl     # bare name resolves under .dcompose/scripts/
dcompose eval '(await mcp.pagerduty.list_oncalls({})).response.map(o => o.user.summary)' -r --jsonl
```

Context members: `mcp.<server>.<tool>(args)`, `mcp.<server>.raw.<tool>(args)`, `call("server.tool", args)`,
`input`, `stdin.{text,json,lines,jsonl}()`, `pmap(items, fn, {concurrency})`, `sleep(ms)`,
`emit(obj)` (NDJSON to stderr), `log(...)`, `runId`, `calls`.

Guardrail flags on `run` and `eval`: `--timeout 30s`, `--max-calls 50`, `--max-output-bytes 64k`,
`--allow 'pd.list_*'`, `--deny 'pd.resolve_*'`, `--read-only`, `--dry-run`. Hitting one exits 2.
An oversized result is written to `.dcompose/runs/<id>.result.json` and stdout gets a small
JSON stub pointing at it, so stdout is always valid JSON.

Every run writes `.dcompose/runs/<UTC time>-<ULID>.jsonl`: a header line, one line per tool
call (server, tool, arg/result sizes, duration, error), and a summary line.

## Monitors, streaming, state

- **Return shape.** Poll, remember state in `ctx.store` (a JSON file at `.dcompose/state/<script>.json`,
  atomic writes), and `return` when something needs the agent. Process exit is the wake-up.
  Run with `--timeout 0 --max-calls 0` in the background and relaunch after handling the result.
- **Yield shape.** Export an `async function*`. Each `yield` is one NDJSON line on stdout, flushed
  immediately; the process keeps running. No mode flag: the runner detects the async iterator.
- **`sh(cmd)`** runs a shell command from inside a script. Requires `--allow-exec`, counts toward
  `--max-calls`, appears in the trace as `$sh`, and is skipped under `--dry-run`.
- **`call --each`** reads NDJSON arg objects from stdin and makes one call per line with bounded
  concurrency, output order preserved. Inline JSON acts as defaults merged under each line.
- **`runs` / `runs show [prefix]`** list past runs and print a per-call trace table.

Example scripts under `.dcompose/scripts/`: `oncall-report.ts` (cross-entity join),
`watch-incidents.ts` (return-shape monitor with baseline), `stream-oncalls.ts` (yield shape).

## Types and checking

```sh
dcompose types            # writes .dcompose/types/mcp.d.ts from every tool's input/output schema
dcompose check [script]   # tsc over .dcompose/scripts against those types
```

The generated file augments `McpServers` in the `dcompose` module, so `ctx.mcp.pagerduty.list_incidents`
is strictly typed in any script that imports `Ctx`. Tools whose server publishes an
`outputSchema` get a real return type; the rest return `any` and say so in their JSDoc.
Hoisted helper types are prefixed per tool so same-named `$defs` from different tools never merge.

`import type { Ctx } from "dcompose"` resolves through `.dcompose/tsconfig.json`, which `types`
regenerates with an absolute path to this install. It is type-only, so Node never needs to
resolve it at runtime. The tsconfig is gitignored because it is machine-specific; the `.d.ts`
is not, and is skipped when the tool-list hash is unchanged.

## Agent onboarding

`dcompose init` writes `.claude/skills/dcompose/SKILL.md`. Claude Code picks it up automatically
and learns the servers → tools → types → script → check → run loop, the guardrail flags, and the
monitor pattern. Pass `--no-skill` to skip it.

## Config

Resolution order, later wins per server name:

1. `~/.dcompose/config.json`
2. `./dcompose.json` (commit this; use `${ENV_VAR}` references for secrets)
3. `./dcompose.local.json` (gitignored; `init --import-claude` writes here)

`--config <path>` or `DCOMPOSE_CONFIG` replaces the chain with one file. Entries use the same
shape as Claude Code's `mcpServers`:

```json
{
  "mcpServers": {
    "pagerduty": { "command": "uvx", "args": ["pagerduty-mcp"], "env": { "PAGERDUTY_API_KEY": "${PD_KEY}" } },
    "datagrip":  { "type": "http", "url": "http://127.0.0.1:64402/stream" }
  },
  "defaults": { "maxCalls": 200, "timeout": "5m", "concurrency": 5, "connectTimeoutMs": 30000 }
}
```

## Conventions

- **stdout is data, stderr is everything else.** Results are JSON, pretty on a TTY, compact
  when piped. Override with `-c` / `--pretty`.
- **Exit codes:** `0` ok · `1` tool or script error · `2` guardrail (not yet used) · `3` config
  or connection error.
- **Result parsing.** `structuredContent` wins; otherwise text blocks that parse as JSON become
  values. `--raw` returns the untouched MCP envelope.
- `-v` forwards MCP server stderr; without it, the last 20 lines are shown only on
  connection failure.

## Layout

```
src/cli.ts              commander entry, exit-code mapping
src/config.ts           schema, resolution chain, ${ENV} expansion, Claude Code import
src/client.ts           Server (one MCP connection) and Registry
src/result.ts           CallToolResult → plain value
src/output.ts           stdout/stderr helpers, table, exit codes
src/commands/*.ts       one file per subcommand
```
