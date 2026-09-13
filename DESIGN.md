# dcompose — design

Let a coding agent compose MCP tool calls in code instead of one tool call per round-trip.
Same idea as Cloudflare's Code Mode and Anthropic's "code execution with MCP" pattern, but
packaged as a local CLI that Claude Code drives through Bash.

## Why a CLI first, MCP server second

| Concern                        | CLI (`dcompose run script.ts`)                                   | MCP server (`run_script` tool)                             |
| ------------------------------ | ---------------------------------------------------------------- | ---------------------------------------------------------- |
| Script authoring               | Agent writes a real file with Write/Edit, can diff and re-run    | Script is a string argument in a tool call; clunky to edit |
| Long-running / monitor         | Bash `run_in_background`; agent is re-invoked when process exits | Request/response; times out or blocks the host             |
| Reuse                          | Scripts accumulate in `.dcompose/scripts/` as a library          | Ephemeral                                                  |
| Discovery of tool types        | Agent reads a generated `.d.ts` file                             | Must return types in a tool result                         |
| Setup                          | Zero registration, works in any host with a shell                | Needs host registration                                    |
| Cold start                     | Spawns/connects MCP servers per run (fix with daemon, phase 5)   | Connections stay warm                                      |
| Portability to non-shell hosts | No                                                               | Yes                                                        |

Decision: build the engine as a library, ship the CLI first, add `dcompose mcp` (an MCP
server exposing `search_tools` + `run_script`) in phase 6 for hosts without a shell.

## Hard constraint to know up front

dcompose runs as a separate process, so it can only reach MCP servers it can connect to itself:
stdio servers and remote HTTP servers where dcompose does its own OAuth. It **cannot** use
Claude Code's claude.ai-hosted connectors (Microsoft 365, Notion, etc.); those tokens
live inside Claude Code. Scenario 2 (Slack) therefore needs a Slack MCP server that
dcompose configures directly.

## Script model

Scripts are TypeScript or JavaScript modules. dcompose injects a typed `mcp` object plus a
small runtime, executes the module's default export, and prints the return value as JSON on
stdout. Logs go to stderr so stdout stays machine-readable.

```ts
// .dcompose/scripts/active-employee-names.ts
export default async function ({ mcp, pmap }) {
  const all = await mcp.hr.listEmployees({});
  const active = all.filter((e) => e.active);
  return pmap(active, (e) => mcp.hr.getEmployee({ id: e.id }).then((r) => r.name), { concurrency: 5 });
}
```

```ts
// .dcompose/scripts/watch-slack.ts  — exits when something is worth the agent's attention
export default async function ({ mcp, input, store, sleep, emit }) {
  const watched: string[] = input.watched; // decided by the agent, passed as --input
  const seen = (await store.get("seen")) ?? {}; // persisted between runs
  while (true) {
    const channels = await mcp.slack.list_channels({});
    for (const c of channels) {
      const last = c.latest_ts;
      if (seen[c.id] === last) continue;
      const isNew = !(c.id in seen);
      seen[c.id] = last;
      await store.set("seen", seen);
      if (isNew) return { kind: "new-channel", channel: c }; // agent must decide watch/ignore
      if (watched.includes(c.id)) return { kind: "message", channel: c };
      emit({ kind: "ignored", channel: c.id }); // stderr NDJSON, not a return
    }
    await sleep(input.intervalMs ?? 30_000);
  }
}
```

### Runtime API injected into scripts

| Name                             | Purpose                                                                                                             |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `mcp.<server>.<tool>(args)`      | Proxy that calls the tool. Parses JSON text content; returns `structuredContent` when present. Throws on `isError`. |
| `mcp.<server>.raw.<tool>(args)`  | Unparsed MCP result for when auto-parse guesses wrong.                                                              |
| `input`                          | Parsed `--input '<json>'` or `--input-file`.                                                                        |
| `pmap(items, fn, {concurrency})` | Bounded-concurrency map. Most compositions need this.                                                               |
| `sleep(ms)`                      | For polling loops.                                                                                                  |
| `emit(obj)`                      | Writes one NDJSON line to stderr (progress / interim events).                                                       |
| `store.get/set/delete`           | JSON KV persisted at `.dcompose/state/<script-name>.json`.                                                          |
| `log(...)`                       | stderr, human-readable.                                                                                             |

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
- `--trace`: stream every call record (server, tool, arg/result sizes, duration) to stderr as
  NDJSON while the script runs. The same records are always written to `.dcompose/runs/<run-id>.jsonl`.
- Run IDs: `<UTC time>-<ULID>`, e.g. `20260911T140211Z-01J7QZ3M8KX4V9R2T6B1N5W0YD`. Sortable, unique
  across concurrent runs, prefix-addressable (`dcompose runs show 20260911T1402`). Printed on stderr
  at start, exposed to the script as `ctx.runId` and to child processes as `DCOMPOSE_RUN_ID`.
  `--label <name>` attaches a human label the agent can search by.

## Shell composability

dcompose is one filter in a pipeline, not a walled garden. Rules:

- **stdout is data, stderr is everything else.** Result JSON only on stdout. Logs, traces, run
  summaries, progress on stderr, always (an agent capturing both streams still wants the summary);
  `-q` silences it. Colour is only used by `check` and is off under `NO_COLOR` or a non-TTY stderr.
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
- **Environment.** `DCOMPOSE_CONFIG`, `DCOMPOSE_HOME`, `DCOMPOSE_RUN_ID`, `DCOMPOSE_NO_DAEMON`,
  `DCOMPOSE_AUTH_DIR`, `NO_COLOR` honoured.
- **Never litter an unconfigured directory.** With only user-level config present, runs/state/types
  go to `~/.dcompose/workspaces/<hash of cwd>/`, not into the cwd. A repo only gets a `.dcompose/`
  folder after an explicit `dcompose init` there.
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
    "hr": { "command": "npx", "args": ["-y", "some-hr-mcp"] },
    "slack": { "type": "http", "url": "https://.../mcp", "oauth": true }
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
3. **Types + agent onboarding.** ✅ Done 2026-09-11. `types` generates `.dcompose/types/mcp.d.ts`
   (130 tools across 3 servers, 92 with output schemas, zero conversion failures) as a module
   augmentation of `McpServers`, so `ctx.mcp` is strictly typed when the file exists and falls
   back to `any` when it does not. Hoisted `$defs` are prefixed per tool after finding 39
   cross-tool name collisions. `check` runs the TypeScript 5 compiler API over
   `.dcompose/scripts` via a generated `.dcompose/tsconfig.json` whose `paths` map `dcompose`
   to this install. `init` writes `.claude/skills/dcompose/SKILL.md`.
   **Cold test passed:** a fresh agent given only SKILL.md and a task (on-call users joined to
   open incidents via escalation policy and service) produced a correct report in 12 commands,
   exit 0, 4 tool calls. Its feedback drove three fixes: `call --read-only`, help hints on
   unknown options, and open output types (`additionalProperties` on output schemas) after it
   found the server's declared schema omitted `id` fields that exist in real payloads. Its
   script is kept as `.dcompose/scripts/oncall-report.ts`.
4. **Long-running.** ✅ Done 2026-09-11. `ctx.store` (per-script JSON at `.dcompose/state/`,
   atomic tmp+rename, `--state <name>` to share), streaming via async-generator scripts (each
   `yield` → one NDJSON stdout line; replaces the planned `--stream` flag, no mode to forget),
   `ctx.sh()` gated by `--allow-exec` and traced as `$sh`, `call --each` (the xargs of MCP),
   `runs` / `runs show`. Scenario 2 mechanics verified with a PagerDuty incident watcher:
   baseline run records 29 open incidents and returns; second run polls and exits 2 on
   `--timeout`. The real Slack version still needs a Slack MCP server dcompose can reach.
5. **Daemon.** ✅ Done 2026-09-11. One detached daemon per project root (named pipe on
   Windows, Unix socket elsewhere), NDJSON request/response, reusing `Registry`/`Server`
   unchanged on the server side. On the client side `Server` gains a `remote` mode that
   delegates `listTools`/`callTool`/`serverInfo` over the socket. Discovery via
   `.dcompose/daemon.json`; stale records are cleaned up; `--no-daemon`, `DCOMPOSE_NO_DAEMON`,
   or `--config` force direct mode. Config-hash mismatch triggers a `reload`. Transport
   `onclose` resets a server so a dead MCP process reconnects on next call. Idle exit (1h).
   Measured: `tools pagerduty` 3.0 s direct → 0.4 s via daemon; warm-up of all three servers
   ~2.7 s once. `autoStart` is opt-in config so no surprise background processes.
6. **Packs.** Package a set of servers plus curated scripts so they install and run identically
   somewhere else. A pack is a directory (git repo or npm package) with:
   - `dcompose.pack.json`: name, version, required env vars with descriptions, exported scripts
     with their input types, default guardrails per script (read-only, call budget, allow list).
   - `servers` using `${ENV}` references only; bare command names, no absolute paths.
   - `scripts/`, a `types/` snapshot with its tool-list hash, a lockfile pinning server versions.
   - `SKILL.md` describing the pack's tools to an agent.
     Commands: `pack` (writes manifest + lockfile; refuses literal secrets or absolute paths),
     `install <source>` (fetch, prompt for missing env, regenerate tsconfig, run doctor),
     `doctor` (env present, servers connect, live tool hash vs snapshot, scripts type-check).
     Script input types (`Ctx<{ days?: number }>`) become JSON schemas at pack time so exported
     scripts have real tool schemas.
     Known limits: claude.ai connectors cannot be packed (no reachable endpoint, no local
     credential); per-user OAuth through a shared gateway is deferred until a host needs it.
7. **MCP mode.** `dcompose mcp [--pack <name>]` serves a pack's exported scripts as MCP tools
   for non-shell hosts, with manifest guardrails applied to every call, plus optional
   `search_tools` / `run_script` for hosts trusted with raw access. Defaults to stdio or
   localhost; remote exposure is a deliberate step that requires its own auth. Solves the
   localhost-only server problem (DataGrip) by gatewaying from the machine that can reach it.

8. **Script isolation.** Today a script runs in the dcompose process as the user, with Node's
   full standard library and, in memory, every server's credentials. Guardrails bound MCP calls
   and nothing else. Add an opt-in `--isolate` that runs the script in a child process with
   Node's permission model (`--permission`, no filesystem or network by default, read access to
   the script directory and `.dcompose/types/`) and hands it `ctx.mcp` over an RPC channel to
   the parent. The parent keeps the MCP clients, the server `env` blocks, and the OAuth tokens;
   the child never sees them. `ctx.sh()` is refused under `--isolate` regardless of
   `--allow-exec`. Config `defaults.isolate: true` makes it the project default, and the pack
   manifest can require it per script. Update SECURITY.md when this lands so "bound, not
   sandboxed" describes only the default mode.
9. **Publish.** `npm install -g dcompose` and `npx dcompose` from the npm registry, replacing
   clone-and-link. Prerequisites: reserve the name or pick a scope, `prepublishOnly` running
   `npm run ci`, the SKILL.md and `patterns.md`/`pitfalls.md` shipped in the package, and the
   `dcompose` path alias in the generated tsconfig resolving to the installed package rather
   than a source checkout. Tag releases from CHANGELOG headings; `dcompose --version` reports
   the package version and a `dcompose upgrade` hint appears once a day when a newer version is
   published.
10. **Import from more clients.** `import` reads Claude Code only. Add `--from <client>` for
    Claude Desktop (`claude_desktop_config.json`), Cursor (`.cursor/mcp.json`, user and project),
    VS Code (`.vscode/mcp.json`, whose `servers` key and `inputs` prompts differ from
    `mcpServers`), Codex (`~/.codex/config.toml`, TOML), and Gemini CLI (`~/.gemini/settings.json`).
    Each becomes a small adapter that returns the common `mcpServers` shape; secrets are handled
    as today (env blocks copied into the local file, `${ENV}` references preserved). The
    existing `init --import-claude` stays as the shorthand for the Claude Code path.
11. **Call shorthand.** `call` takes a JSON object. Add `key=value` (string), `key:=value`
    (JSON), and `key=@file` arguments so one-off calls need no quoting gymnastics in a shell:
    `dcompose call pagerduty.list_incidents statuses:='["triggered"]' limit:=5`. JSON remains
    the canonical form and the two cannot be mixed in one invocation. Also `-o md` to render
    array-of-object results as a Markdown table for direct pasting into a reply.
12. **Record and replay.** Traces record call metadata, not payloads. Add `run --record` to
    store full arguments and results alongside the trace, and `run --replay <run-id>` to serve
    those results back to the script instead of calling servers. The agent can then iterate on
    the filtering and shaping half of a script offline, against the same data, without
    re-paying the API calls or the cold start. Recordings hold real data and live under
    `.dcompose/runs/`, which is already gitignored. `runs show` marks recorded runs, and a
    `runs prune --recorded` command deletes them.
13. **Credential storage.** OAuth tokens live in `~/.dcompose/auth/` as mode-0600 files, which
    Windows does not honour. Store them in the OS keystore where one exists (Windows Credential
    Manager, macOS Keychain, Secret Service on Linux) with the file as fallback, and add
    `${SECRET:name}` references in server config that resolve from the same keystore, so
    `dcompose.json` can be committed with neither literal tokens nor a dependency on the
    shell environment. `auth --status` reports which backend holds each token.

## Open questions

- ~~Should scripts be able to `import` npm packages from the project?~~ Resolved: they already
  can. Node resolves imports from the script's own location upward, so a project's `node_modules`
  is found with no dcompose involvement.
- Auto-parse heuristics: some servers return Markdown tables, not JSON. Provide `raw` and
  let the agent handle it; do not try to parse Markdown.
- Windows: stdio servers spawned via `npx`/`uvx` need shell resolution. Reuse the same spawn
  logic Claude Code uses (`cmd /c` on win32) or require full paths.

## Auth regimes (what dcompose can and cannot reuse from Claude Code)

| Regime                                                      | Example                                                                 | dcompose access                                                                                                                                                                     | Import behaviour                                    |
| ----------------------------------------------------------- | ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| Stdio server                                                | pagerduty via `uvx`, chrome-devtools via `npx`                          | Full. Spawn same command + env.                                                                                                                                                     | Copy entry verbatim                                 |
| Remote + static headers / env var                           | `"headers": {"Authorization": "Bearer ${TOKEN}"}`                       | Full. Secret is already in config.                                                                                                                                                  | Copy entry verbatim                                 |
| Remote + OAuth done by Claude Code                          | Locally added `https://mcp.example.com/mcp`                             | `dcompose auth <server>`: our own OAuth 2.1 flow (PKCE, dynamic registration) against the same URL; tokens under `~/.dcompose/auth/`. We do **not** read Claude Code's token store. | Copy URL; a 401 names the `auth` command to run     |
| claude.ai-hosted connector                                  | `mcp__claude_ai_*` (Microsoft 365, Notion, Atlassian, Rock MCP Staging) | None. Tokens live on Anthropic's servers.                                                                                                                                           | Skip with message; suggest public endpoint if known |
| Sender-constrained (DPoP / mTLS) or allow-listed client IDs | Enterprise gateways                                                     | None until admin registers dcompose                                                                                                                                                 | Skip with message                                   |

Inverse does not help: an MCP server cannot call the host's other tools, so `dcompose mcp`
is equally isolated from connectors.
