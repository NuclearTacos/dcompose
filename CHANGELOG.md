# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Planned
- Packs: package servers plus curated scripts for install elsewhere (`pack`, `install`, `doctor`).
- MCP mode: serve a pack's scripts as MCP tools for hosts without a shell.
- OAuth 2.1 for remote servers (`dcompose auth <server>`).

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
