# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
- `dcompose auth <server>`: OAuth 2.1 sign-in for remote servers (PKCE and dynamic client
  registration via the MCP SDK, loopback callback on 127.0.0.1, tokens under `~/.dcompose/auth/`).
  Normal connections pick stored tokens up and refresh them; a 401 now names the command to run.
  Flags: `--status`, `--reset`, `--no-browser`, `--scope`, `--timeout`. Verified live against
  New Relic's MCP server, whose authorization server requires a `state` parameter; dcompose
  sends a random one and verifies it on the callback.
- `--trace` on `run` and `eval`: stream each call record to stderr as NDJSON while running.
- `ctx.paginate(fetchPage, { maxPages, maxItems })`: cursor paging helper.
- `check <dir>` type-checks every script in a directory; CI now checks `examples/`.
- `NO_COLOR` or a non-TTY stderr disables colour in `check` diagnostics.
- `import [names...]`: copy servers from Claude Code's config into the user-level
  `~/.dcompose/config.json` (default) or `./dcompose.local.json` (`--project`). Replaces
  running `init --import-claude` inside repos that should not gain dcompose files.
- `ctx.unwrap(value)`: parse JSON that a server returned inside a string field
  (PagerDuty's analytics tools do this). `dcompose call` prints a note naming such fields.
- `where`, `skill --user|--project`, `new <name> [--stream]` (scaffolds the default-export
  skeleton at the resolved scripts path and prints it).
- `servers` and `types` exit 0 with a warning when an unrelated server fails to connect, as
  long as output was produced; `--strict` restores exit 3. `run` and `check` echo the resolved
  script path so bare names are traceable in workspace mode.
- Directories with no project config get a per-directory workspace under
  `~/.dcompose/workspaces/` for runs, state, and types, so running on user-level config alone
  never writes into someone else's repo. `DCOMPOSE_HOME` relocates `~/.dcompose`.

### Changed
- Docs: removed the never-implemented `DCOMPOSE_PROFILE`; closed the npm-imports question,
  since scripts can already import from the project's `node_modules`.
- `init --import-claude` now adds `dcompose.local.json` and `.dcompose/` to the enclosing
  repo's `.gitignore` when missing and reports exactly what git will do, instead of claiming
  the file was gitignored. Found by a real session that wrote an API key into an unignored file.

### Fixed
- OAuth token refresh never ran for non-interactive connections: the MCP SDK treats a provider
  without a redirect URL as a client-credentials flow and skips the refresh branch, so stored
  tokens failed after the first expiry. The provider now always presents the registered
  redirect URL (or a loopback placeholder), and fails fast with the `dcompose auth` hint when
  nothing is stored rather than registering a throwaway client.

### Planned
- Packs: package servers plus curated scripts for install elsewhere (`pack`, `install`, `doctor`).
- MCP mode: serve a pack's scripts as MCP tools for hosts without a shell.
- Smarter `--dry-run`: return schema-shaped empty values instead of `null` so scripts that
  destructure results can be dry-run end to end.

## [0.1.0] - 2026-09-12

First working release. Built and verified against live PagerDuty, Chrome DevTools, and
DataGrip MCP servers on Windows.

### Added
- **Config**: three-file resolution chain (`~/.dcompose/config.json` → `dcompose.json` →
  `dcompose.local.json`), `${ENV}` expansion, `init --import-claude` to seed from Claude Code.
- **Connections**: stdio, streamable HTTP, and SSE clients over the official MCP SDK.
- **Commands**: `servers`, `tools`, `call` (with `--each` for NDJSON fan-out), `run`, `eval`,
  `types`, `check`, `runs`, `daemon`.
- **Scripts**: default-export modules receive a context with `mcp.<server>.<tool>()`, `call`,
  `input`, `stdin`, `pmap`, `sleep`, `emit`, `log`, `store`, `sh`, `runId`. Async-generator
  scripts stream one NDJSON line per `yield`.
- **Guardrails**: `--timeout`, `--max-calls`, `--max-output-bytes` (spills to a file, stdout
  stays valid JSON), `--allow` / `--deny` globs, `--read-only` from MCP annotations,
  `--dry-run`, `--allow-exec`. Guardrail hits exit 2; script errors exit 1; config errors exit 3.
- **Traces**: every run writes `.dcompose/runs/<UTC>-<ULID>.jsonl` with header, per-call, and
  summary lines; `runs show` renders them.
- **Types**: `types` generates a `.d.ts` from every tool's input and output schema as a module
  augmentation, so `ctx.mcp` is strictly typed. Requested names are pinned, hoisted `$defs` are
  prefixed per tool, output objects are open so undeclared fields are `any` not errors.
- **Daemon**: per-project process holding MCP connections warm over a named pipe or Unix
  socket; commands use it automatically, reload it on config change, and fall back to direct
  connections when it is absent.
- **Agent onboarding**: `init` writes `.claude/skills/dcompose/SKILL.md`.

### Measured
- Same two-day PagerDuty digest: one model round-trip and 940 bytes into context via dcompose,
  versus eight round-trips via native tool calls, where the host refused each 60 KB page.
- `tools` against a `uvx` server: 3.0 s direct, 0.4 s via the daemon.

[Unreleased]: https://github.com/NuclearTacos/dcompose/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/NuclearTacos/dcompose/releases/tag/v0.1.0
