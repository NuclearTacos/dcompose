---
name: dcompose
description: Compose several MCP tool calls in one TypeScript script instead of one tool call per turn. Use when a task needs a list-then-lookup fan-out, cross-server joins, filtering large tool results down to a few fields, paging past a server's row cap, polling/monitoring until a condition is met, or any chain of 3+ tool calls where intermediate data does not need to be seen. Also use when a needed MCP server is configured in dcompose but not available as a native tool.
---

# dcompose

Run MCP tool calls from a script so only the final value enters your context. stdout is the
result as JSON. stderr is logs and a run summary. Exit codes: 0 ok, 1 script or tool error,
2 guardrail hit (timeout, call budget, denied tool, output cap), 3 config or connection error.

One `dcompose run` is one shell command: one permission check and one round-trip for the whole
script, however many tool calls it makes. That is why the guardrail flags below matter.

Companion files in this folder, read them when relevant:

- **patterns.md**: complete, runnable script shapes (fan-out, join, paging, aggregate, monitor,
  stream, stdin pipeline, shell mix). Start from the closest one instead of from scratch.
- **pitfalls.md**: what has actually gone wrong and how to avoid it. Read it the first time a
  run fails for a reason you did not expect.

## When to use it (and when not)

Use dcompose when any of these is true:

- You would make the same tool call for each item in a list.
- You need fields from two or more tools joined together.
- A result will be large and you only need a few fields or a count.
- A list tool caps its page size and you need everything.
- You are waiting for something to change (poll, then act).

Do not use it for a single call with a small result; call the tool directly. Do not use it to
avoid reading data you actually need to reason about.

## Workflow

1. **See what is available.**
   ```sh
   dcompose servers                      # names, connection status, tool counts
   dcompose tools <server> --grep <word> # server.tool + one-line description + [read-only]
   ```
2. **Read the exact signatures.** `dcompose types` writes `.dcompose/types/mcp.d.ts`.
   Grep it for the tool name instead of guessing argument names. Input types are exact.
   **Output types are only as good as the server's declared schema**: they often omit fields
   that are really there, and tools with no schema return `any`. Before joining on a field,
   probe one real call:
   ```sh
   dcompose call <server>.<tool> '{"limit":2}' --read-only
   ```
3. **Write the script** at `.dcompose/scripts/<name>.ts`. Copy the closest shape from
   patterns.md. Return only what you need; anything you return lands in your context.
4. **Type-check, then run.**
   ```sh
   dcompose check <name>
   dcompose run <name> -i '{"limit":10}' --read-only       # bare name resolves under .dcompose/scripts/
   ```
5. **Iterate.** A non-zero exit prints the reason on stderr. Script bugs show the frame in your
   file. Add `--trace` to watch each call as it happens. `dcompose runs show` replays the last run.

## Context passed to the script

| Member                                                        | Use                                                                                         |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `mcp.<server>.<tool>(args)`                                   | Call a tool; result is parsed JSON. Hyphenated names: `mcp["chrome-devtools"].list_pages()` |
| `mcp.<server>.raw.<tool>(args)`                               | Unparsed MCP envelope when auto-parse is wrong                                              |
| `call("server.tool", args)`                                   | Same as above by string name                                                                |
| `input`                                                       | From `-i '<json>'`, `--input-file <path>`, or `-i -` (stdin)                                |
| `stdin.text() / .json() / .lines() / .jsonl()`                | Piped data                                                                                  |
| `pmap(items, fn, { concurrency })`                            | Bounded fan-out; use this instead of `Promise.all`                                          |
| `paginate(async (cursor) => ({ items, next }), { maxPages })` | Cursor paging; returns all items                                                            |
| `sleep(ms)`                                                   | Polling loops                                                                               |
| `emit(obj)`                                                   | Interim NDJSON event on stderr (not the return value)                                       |
| `log(...)`                                                    | Human-readable stderr                                                                       |
| `store.get/set/delete/all`                                    | JSON state persisted at `.dcompose/state/<script>.json` across runs                         |
| `sh(cmd)`                                                     | Shell command; only with `--allow-exec`                                                     |
| `runId`, `calls`                                              | Current run id; tool calls made so far                                                      |

## Guardrails

`run` and `eval` accept all of these; `call` accepts only `--read-only`.

- `--read-only` refuses tools not annotated readOnlyHint (exit 2). Use it unless you intend to write.
- `--allow 'pd.list_*,pd.get_*'` / `--deny 'pd.resolve_*'` limit which tools may be called.
- `--max-calls 50`, `--timeout 2m` bound the run. Defaults come from dcompose.json.
- `--dry-run` logs every call it would make and executes none. Use before any write.
- `--trace` streams each tool call to stderr as it happens; useful on long or stuck runs.
- Results over `--max-output-bytes` (default 64k) are written to `.dcompose/runs/<id>.result.json`
  and stdout gets a small stub pointing at the file, with exit 2. Return less, or read the file.

Pick flags by intent: **read-only report** → `--read-only --max-calls N`. **Write action** →
first `--dry-run`, then `--allow` naming exactly the write tools, never `--read-only`.
**Monitor** → `--timeout 0 --max-calls 0 --read-only -q`.

## One-liners

```sh
dcompose eval '(await mcp.pagerduty.list_oncalls({})).response.map(o => o.user.summary)' -r --jsonl
dcompose call pagerduty.get_incident '{"incident_id":"Q123"}' | jq .response.title
jq -c '.[] | {id}' items.json | dcompose call server.get_thing --each --concurrency 5
```

## Long-running monitors

**Return shape**: poll, remember state in `store`, `return` only when something needs
attention. Run in the background; process exit is the notification; relaunch after handling.
**Yield shape**: `async function*`; every `yield` is one NDJSON line on stdout immediately.
Both are written out in full in patterns.md.

## Remote servers that need sign-in

If a server fails with "requires authentication", run `dcompose auth <server>` once. It opens a
browser for OAuth and stores tokens; later commands use them silently. Ask the user to do this
step, since it needs their browser session.

## Speed: start the daemon once per session

Each command normally spawns the MCP servers fresh (seconds for `uvx`/`npx` servers). A
per-project daemon keeps them connected; every command uses it automatically when running.

```sh
dcompose daemon start      # once; exits itself after 1h idle
```

## Do not

- Do not call `Promise.all` over hundreds of items; use `pmap`.
- Do not return whole records when a few fields answer the question.
- Do not guess argument names; read `.dcompose/types/mcp.d.ts` or probe with `dcompose call`.
- Do not parse stderr as data. Only stdout is the result.
- Do not hand-roll paging loops; use `paginate`.
