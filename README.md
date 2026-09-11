# dcompose

Compose MCP tool calls in code instead of one tool call per model round-trip. A local CLI a
coding agent drives through its shell. See [DESIGN.md](DESIGN.md) for the why and
[EXAMPLES.md](EXAMPLES.md) for the target usage.

**Status: phase 1.** `init`, `servers`, `tools`, `call` work against stdio and HTTP servers.
`run` (scripts), types, guardrails, and OAuth are not built yet.

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
