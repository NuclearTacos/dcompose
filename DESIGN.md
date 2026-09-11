# dcompose — design

Let a coding agent compose MCP tool calls in code instead of one tool call per round-trip.
Same idea as Cloudflare's Code Mode and Anthropic's "code execution with MCP" pattern, but
packaged as a local CLI that Claude Code drives through Bash.

## Why a CLI first, MCP server second

| Concern | CLI (`dcompose run script.ts`) | MCP server (`run_script` tool) |
|---|---|---|
| Script authoring | Agent writes a real file with Write/Edit, can diff and re-run | Script is a string argument in a tool call; clunky to edit |
| Long-running / monitor | Bash `run_in_background`; agent is re-invoked when process exits | Request/response; times out or blocks the host |
| Reuse | Scripts accumulate in `.dcompose/scripts/` as a library | Ephemeral |
| Discovery of tool types | Agent reads a generated `.d.ts` file | Must return types in a tool result |
| Setup | Zero registration, works in any host with a shell | Needs host registration |
| Cold start | Spawns/connects MCP servers per run (fix with daemon, phase 5) | Connections stay warm |
| Portability to non-shell hosts | No | Yes |

Decision: build the engine as a library, ship the CLI first, add `dcompose mcp` (an MCP
server exposing `search_tools` + `run_script`) in phase 6 for hosts without a shell.

## Hard constraint to know up front

dcompose runs as a separate process, so it can only reach MCP servers it can connect to itself:
stdio servers and remote HTTP servers where dcompose does its own OAuth. It **cannot** use
Claude Code's claude.ai-hosted connectors (Microsoft 365, Rock MCP Staging, etc.); those tokens
live inside Claude Code. Scenario 2 (Teams) therefore needs a Teams/Graph MCP server that
dcompose configures directly.

## Script model

Scripts are TypeScript or JavaScript modules. dcompose injects a typed `mcp` object plus a
small runtime, executes the module's default export, and prints the return value as JSON on
stdout. Logs go to stderr so stdout stays machine-readable.

```ts
// .dcompose/scripts/active-employee-names.ts
export default async function ({ mcp, pmap }) {
  const all = await mcp.hr.listEmployees({});
  const active = all.filter(e => e.active);
  return pmap(active, e => mcp.hr.getEmployee({ id: e.id }).then(r => r.name), { concurrency: 5 });
}
```

```ts
// .dcompose/scripts/watch-teams.ts  — exits when something is worth the agent's attention
export default async function ({ mcp, input, store, sleep, emit }) {
  const watched: string[] = input.watched;              // decided by the agent, passed as --input
  const seen = (await store.get("seen")) ?? {};         // persisted between runs
  while (true) {
    const chats = await mcp.teams.listChats({});
    for (const c of chats) {
      const last = c.lastMessageId;
      if (seen[c.id] === last) continue;
      const isNew = !(c.id in seen);
      seen[c.id] = last;
      await store.set("seen", seen);
      if (isNew) return { kind: "new-chat", chat: c };             // agent must decide watch/ignore
      if (watched.includes(c.id)) return { kind: "message", chat: c };
      emit({ kind: "ignored", chat: c.id });                        // stderr NDJSON, not a return
    }
    await sleep(input.intervalMs ?? 30_000);
  }
}
```

### Runtime API injected into scripts

| Name | Purpose |
|---|---|
| `mcp.<server>.<tool>(args)` | Proxy that calls the tool. Parses JSON text content; returns `structuredContent` when present. Throws on `isError`. |
| `mcp.<server>.raw.<tool>(args)` | Unparsed MCP result for when auto-parse guesses wrong. |
| `input` | Parsed `--input '<json>'` or `--input-file`. |
| `pmap(items, fn, {concurrency})` | Bounded-concurrency map. Most compositions need this. |
| `sleep(ms)` | For polling loops. |
| `emit(obj)` | Writes one NDJSON line to stderr (progress / interim events). |
| `store.get/set/delete` | JSON KV persisted at `.dcompose/state/<script-name>.json`. |
| `log(...)` | stderr, human-readable. |

### Result handling

- MCP results are `content: [{type:"text", text}]`. If `text` parses as JSON, return the parsed
  value (single text block → value; multiple → array). Otherwise return the string.
- If the server sets `structuredContent`, prefer it.
- Enforce `--max-output-bytes` (default 64 KB) on the final return value so a script cannot
  dump a giant record back into the agent's context. Truncate with a clear marker.

### Type generation

`dcompose types` converts every tool's `inputSchema` (and `outputSchema` when present) to
TypeScript via `json-schema-to-typescript` and writes `.dcompose/types/mcp.d.ts`. The agent
reads that file instead of the raw tool list. Tools without `outputSchema` return `any`
with the tool description as a JSDoc comment. Cached by server + tool-list hash.

## Guardrails (scripts are LLM-written)

Isolation is not the goal; the agent already has Bash. The goal is a bounded, observable run.

- `--max-calls N` (default 200): hard cap on tool invocations per run.
- `--timeout <dur>` (default 5m; `--timeout 0` for monitors).
- `--allow server.tool,server.*` / `--deny ...`: tool allowlist. Default: allow all.
- `--read-only`: refuse tools whose annotations lack `readOnlyHint: true`.
- `--dry-run`: log every call with args, return `null` instead of executing.
- `--trace`: NDJSON of every call (server, tool, args size, duration, result size) to stderr.
  Same data is written to `.dcompose/runs/<run-id>.jsonl` always.
- Run IDs: `<UTC time>-<ULID>`, e.g. `20260911T140211Z-01J7QZ3M8KX4V9R2T6B1N5W0YD`. Sortable, unique
  across concurrent runs, prefix-addressable (`dcompose runs show 20260911T1402`). Printed on stderr
  at start, exposed to the script as `ctx.runId` and to child processes as `DCOMPOSE_RUN_ID`.
  `--label <name>` attaches a human label the agent can search by.

## Shell composability

dcompose is one filter in a pipeline, not a walled garden. Rules:

- **stdout is data, stderr is everything else.** Result JSON only on stdout. Logs, traces, run
  summaries, progress on stderr. Colour and summaries auto-disable when stdout is not a TTY.
- **Output shaping flags** mirror `jq`: `--jsonl` prints one line per array element,
  `-r/--raw-output` prints bare strings without quotes, `-c` compact (default when piped).
- **stdin is input.** If stdin is not a TTY it is available as `ctx.stdin.text()`,
  `ctx.stdin.json()`, `ctx.stdin.lines()`, and `ctx.stdin.jsonl()` (async iterators). `--input -`
  makes stdin the `input` object.
- **`dcompose eval '<code>'`** runs an inline async body with the same context, like `node -e`.
- **`dcompose call <server.tool> --each`** reads NDJSON args from stdin, one call per line,
  bounded concurrency, NDJSON results out. The `xargs` of MCP.
- **Exit codes are stable** (0/1/2/3) and `set -e` friendly. Guardrail hits are exit 2, not 1,
  so a script can distinguish "my code is wrong" from "I hit a limit".
- **Environment.** `DCOMPOSE_CONFIG`, `DCOMPOSE_RUN_ID`, `DCOMPOSE_PROFILE`, `NO_COLOR` honoured.
- **Scripts can shell out, opt-in.** `ctx.sh(cmd, {stdin})` returns `{stdout, stderr, code}`
  and is enabled only with `--allow-exec`. Recorded in the run trace like a tool call. Off by
  default because a read-only run should mean read-only.

## Config

`dcompose.json` in project root, or `~/.dcompose/config.json`. Same shape as Claude Code's
`mcpServers` block so entries can be copied verbatim. `--import-claude` flag reads
`~/.claude.json` and `./.mcp.json` and merges in stdio + HTTP servers (skips connectors).

```json
{
  "mcpServers": {
    "hr":    { "command": "npx", "args": ["-y", "some-hr-mcp"] },
    "teams": { "type": "http", "url": "https://.../mcp", "oauth": true }
  },
  "defaults": { "maxCalls": 200, "timeout": "5m", "concurrency": 5 }
}
```

## CLI surface

```
dcompose servers                       list configured servers + connection status
dcompose tools [server] [--json]       compact tool list (name + one-line description)
dcompose types [--out path]            regenerate .d.ts
dcompose auth <server>                 OAuth 2.1 consent flow for a remote server
dcompose call <server>.<tool> '<json>' one call, for debugging; `--each` maps over NDJSON stdin
dcompose eval '<code>'                 inline script body, same context as run
dcompose run <script> [--input json|-] [--input-file f] [--label] [--stream] [--jsonl] [-r]
                      [--timeout] [--max-calls] [--read-only] [--allow] [--deny] [--dry-run] [--allow-exec]
dcompose runs [show <id-prefix>|--label <name>]  list / inspect past runs
dcompose init                          create dcompose.json, .dcompose/, and a SKILL.md for the agent
dcompose daemon [start|stop|status]    phase 5
dcompose mcp                           phase 6: serve as an MCP server
```

Exit codes: 0 script returned; 1 script threw; 2 guardrail hit (timeout / max-calls / denied);
3 config or connection error. The agent branches on these.

## Stack

- Node ≥ 22 (native TS type-stripping; you have v26). Package as TS, run scripts via
  `import()` after stripping types with `node --experimental-strip-types` or `amaro`.
- `@modelcontextprotocol/sdk` (1.30 current) for stdio + streamable-HTTP clients and OAuth.
- `json-schema-to-typescript` for `types`.
- `commander` for CLI. `zod` for config validation.
- npm name `dcompose` is taken (abandoned "Asset composer", 2022). Publish under a scope or
  pick another name; the binary can still be `dcompose`.

## Phases

1. **Connect + inspect.** ✅ Done 2026-09-11. Config loading with the three-file chain and
   `${ENV}` expansion, `init --import-claude`, stdio + streamable-HTTP + SSE clients, `servers`,
   `tools`, `call`, result parsing, exit codes. Verified against pagerduty (uvx), chrome-devtools
   (npx on Windows), and datagrip (HTTP). Observed: uvx cold start is ~5 s per invocation, which
   is the motivation for the phase 5 daemon.
2. **`run` with the `mcp` proxy.** ✅ Done 2026-09-11. Proxy-based `mcp.server.tool()`, `pmap`,
   `input` (inline / file / stdin), `stdin` helper, `eval` for one-liners, run IDs
   (`<UTC>-<ULID>`), NDJSON trace files, stderr summary, output cap that spills to a
   `.result.json` and leaves valid JSON on stdout. Pulled forward from phase 4 because the runner
   needed the seams anyway: `--timeout`, `--max-calls`, `--allow`/`--deny`, `--read-only`,
   `--dry-run`, `sleep`, `emit`. Scenario 1 verified against PagerDuty (list → fan-out → compact).
   Phase 4 now reduces to `store`, `--stream`, `--allow-exec` / `sh()`, and the monitor pattern docs.
3. **Types + agent onboarding.** `types` command, `init` writes `SKILL.md` teaching the
   workflow: `tools` → read `.d.ts` → write script → `run`. Test it by letting Claude Code
   solve scenario 1 cold.
4. **Long-running.** `sleep`, `emit`, `store`, `--timeout 0`, `--max-calls`, `--read-only`,
   `--dry-run`. Scenario 2 works against a Teams MCP server dcompose owns. Document the
   pattern: run with `run_in_background`, script returns → process exits → agent wakes.
5. **Daemon.** `dcompose daemon` keeps MCP connections warm over a local socket; `run`
   uses it when present. Fixes per-run cold start and OAuth re-prompts.
6. **MCP mode.** `dcompose mcp` exposes `search_tools` and `run_script` for non-shell hosts.

## Open questions

- Should scripts be able to `import` npm packages from the project? Useful (lodash, date-fns),
  but widens the surface. Lean yes, resolved from the project's `node_modules`.
- Auto-parse heuristics: some servers return Markdown tables, not JSON. Provide `raw` and
  let the agent handle it; do not try to parse Markdown.
- Windows: stdio servers spawned via `npx`/`uvx` need shell resolution. Reuse the same spawn
  logic Claude Code uses (`cmd /c` on win32) or require full paths.

## Auth regimes (what dcompose can and cannot reuse from Claude Code)

| Regime | Example | dcompose access | Import behaviour |
|---|---|---|---|
| Stdio server | pagerduty via `uvx`, chrome-devtools via `npx` | Full. Spawn same command + env. | Copy entry verbatim |
| Remote + static headers / env var | `"headers": {"Authorization": "Bearer ${TOKEN}"}` | Full. Secret is already in config. | Copy entry verbatim |
| Remote + OAuth done by Claude Code | Locally added `https://mcp.example.com/mcp` | Do our own OAuth 2.1 flow against the same URL. Do **not** read Claude Code's token store. | Copy URL, mark `"oauth": true`, prompt on first use |
| claude.ai-hosted connector | `mcp__claude_ai_*` (Microsoft 365, Notion, Atlassian, Rock MCP Staging) | None. Tokens live on Anthropic's servers. | Skip with message; suggest public endpoint if known |
| Sender-constrained (DPoP / mTLS) or allow-listed client IDs | Enterprise gateways | None until admin registers dcompose | Skip with message |

Inverse does not help: an MCP server cannot call the host's other tools, so `dcompose mcp`
is equally isolated from connectors.
