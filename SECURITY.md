# Security

## Threat model, plainly

dcompose runs code that a language model wrote, against MCP servers that hold real credentials.
It is a local developer tool for an agent that already has a shell. Its guardrails **bound** a
run; they do **not** sandbox it.

What the guardrails do:

- `--read-only` refuses any tool the server did not annotate `readOnlyHint: true`. This trusts
  the server's annotations.
- `--allow` / `--deny` limit which `server.tool` names a script may call.
- `--max-calls`, `--timeout`, `--max-output-bytes` bound resource use and what reaches the agent.
- `--dry-run` executes nothing and logs what would have been called.
- `sh()` is disabled unless `--allow-exec` is passed, and is recorded in the trace.

What they do not do:

- A script runs as your user with Node's full standard library. It can read and write files,
  open sockets, and import packages. Nothing about `--read-only` restricts that; it only
  restricts MCP tool calls. If you need isolation, run dcompose inside a container or VM.
- `dcompose eval` compiles the argument as a function body. Do not pass untrusted strings to it.

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
