# Security

## Threat model, plainly

dcompose runs code that a language model wrote, against MCP servers that hold real credentials.
It is a local developer tool for an agent that already has a shell. By default its guardrails
**bound** a run; they do **not** sandbox it. `--isolate` adds a sandbox; see below.

What the guardrails do:

- `--read-only` refuses any tool the server did not annotate `readOnlyHint: true`. This trusts
  the server's annotations.
- `--allow` / `--deny` limit which `server.tool` names a script may call.
- `--max-calls`, `--timeout`, `--max-output-bytes` bound resource use and what reaches the agent.
- `--dry-run` executes nothing and logs what would have been called.
- `sh()` is disabled unless `--allow-exec` is passed, and is recorded in the trace.

What they do not do:

- Without `--isolate`, a script runs as your user with Node's full standard library. It can read
  and write files, open sockets, and import packages. Nothing about `--read-only` restricts that;
  it only restricts MCP tool calls.
- `dcompose eval` compiles the argument as a function body. Do not pass untrusted strings to it.

## `--isolate`

`dcompose run --isolate` (or `"defaults": { "isolate": true }` in config) runs the script in a
child process started with Node's permission model. The parent process keeps the MCP connections,
the server `env` blocks, the OAuth tokens, the trace, and every guardrail; the child receives a
proxy context and forwards `mcp.*`, `call`, and `store` operations to the parent over IPC. Each
forwarded call goes through the same `--read-only`, `--allow`, `--max-calls`, and `--dry-run`
checks as an in-process run, so the script cannot bypass them from inside the child.

What the child cannot do:

- Read files outside its allowance: the script's own directory, the project's `node_modules`, and
  dcompose's install directory. It cannot write anywhere; `store` writes happen in the parent.
- Spawn processes, start worker threads, load native addons, or use WASI. `sh()` throws a
  guardrail error regardless of `--allow-exec`.
- See the parent's environment. The child gets `PATH`, temp-directory, and terminal variables
  only, plus `DCOMPOSE_ISOLATED=1` and `DCOMPOSE_RUN_ID`.
- Open sockets, on Node builds that restrict network under `--permission` (those that accept
  `--allow-net`). On Node 22 and 24 the permission model does not cover network access, and the
  run header says `isolated (network open on this Node)` so this is not silently assumed.

What it still is not:

- A boundary against Node itself. The permission model is a process-level policy, not a VM. If
  the threat is a hostile script rather than a careless one, run dcompose inside a container.
- On by default. Existing scripts that read project files or import from outside `node_modules`
  need `--input-file` or restructuring before a project flips `defaults.isolate`.

## Credentials

- `dcompose.local.json` is gitignored because `init --import-claude` copies server `env` blocks
  verbatim, which commonly include API tokens. Never commit it. Prefer `${ENV_VAR}` references
  in the tracked `dcompose.json`.
- dcompose does not read Claude Code's OAuth token store and has no intention to.
  `dcompose auth <server>` runs its own OAuth 2.1 authorization-code flow (PKCE, dynamic client
  registration, loopback redirect on 127.0.0.1) and stores the resulting tokens under
  `~/.dcompose/auth/`, one file per server URL, mode 0600 where the platform supports it. Normal
  connections use and refresh those tokens silently; if a server demands a fresh sign-in they
  fail with a message instead of opening a browser. `dcompose auth <server> --reset` deletes the
  stored state.
- One `dcompose run` is one shell command. In Claude Code that means one permission check for
  the whole script rather than one per MCP call. That is a convenience and a responsibility: the
  guardrail flags (`--read-only`, `--allow`, `--max-calls`) are how you bound what that single
  approval can do.
- The daemon listens on a named pipe (Windows) or a Unix socket under `~/.dcompose/daemons/`.
  It does no authentication of its own; anything running as your user can reach it and call any
  configured tool. That is the same trust boundary as the config file itself.
- Run traces under `.dcompose/runs/` record tool names, argument sizes, and result sizes, not
  argument or result contents. A spilled oversized result (`*.result.json`) does contain content.

## Reporting

Open a GitHub issue for anything that is not sensitive. For something that is, use GitHub's
private vulnerability reporting on the repository, or contact the maintainer directly through
their GitHub profile.
