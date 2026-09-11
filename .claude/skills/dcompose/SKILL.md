---
name: dcompose
description: Compose several MCP tool calls in one TypeScript script instead of one tool call per turn. Use when a task needs a list-then-lookup fan-out, cross-server joins, filtering large tool results down to a few fields, polling/monitoring until a condition is met, or any chain of 3+ tool calls where intermediate data does not need to be seen. Also use when a needed MCP server is configured in dcompose but not available as a native tool.
---

# dcompose

Run MCP tool calls from a script so only the final value enters your context. stdout is the
result as JSON. stderr is logs and a run summary. Exit codes: 0 ok, 1 script or tool error,
2 guardrail hit (timeout, call budget, denied tool, output cap), 3 config or connection error.

## Workflow

1. **See what is available.**
   ```sh
   dcompose servers                      # names, connection status, tool counts
   dcompose tools <server> --grep <word> # server.tool + one-line description + [read-only]
   ```
2. **Read the exact signatures.** `dcompose types` writes `.dcompose/types/mcp.d.ts`.
   Grep it for the tool name instead of guessing argument names. Input types are exact.
   **Output types are only as good as the server's declared schema**: they often omit fields
   that are really there (ids, nested objects), and tools with no schema return `any`.
   Undeclared fields type as `unknown`, not as errors. Before joining on a field, probe one
   real call and look at the shape:
   ```sh
   dcompose call pagerduty.list_oncalls '{"limit":2}' --read-only
   ```
   List tools usually cap page size (PagerDuty rejects `limit > 100`) and may not expose an
   offset. Check the input type for `offset`/`cursor`/`page` and loop if you need everything.
3. **Write the script** at `.dcompose/scripts/<name>.ts`:
   ```ts
   import type { Ctx } from "dcompose";

   export default async function ({ mcp, pmap, input }: Ctx<{ limit?: number }>) {
     const { response } = await mcp.pagerduty.list_incidents({ statuses: ["triggered"], limit: input.limit ?? 20 });
     return pmap(response, async (i) => {
       const notes = await mcp.pagerduty.list_incident_notes({ incident_id: i.id });
       return { id: i.id, title: i.title, notes: notes.response.length };
     }, { concurrency: 5 });
   }
   ```
   Return only what you need. Anything you return lands in your context.
4. **Type-check, then run.**
   ```sh
   dcompose check <name>                                   # tsc against the generated types
   dcompose run <name> -i '{"limit":10}' --read-only       # bare name resolves under .dcompose/scripts/
   ```
5. **Iterate.** A non-zero exit prints the reason on stderr. Script bugs show the frame in your
   file. Every run's per-call trace is at `.dcompose/runs/<run-id>.jsonl`.

## Context passed to the script

| Member | Use |
|---|---|
| `mcp.<server>.<tool>(args)` | Call a tool; result is parsed JSON. Hyphenated names: `mcp["chrome-devtools"].list_pages()` |
| `mcp.<server>.raw.<tool>(args)` | Unparsed MCP envelope when auto-parse is wrong |
| `call("server.tool", args)` | Same as above by string name |
| `input` | From `-i '<json>'`, `--input-file <path>`, or `-i -` (stdin) |
| `stdin.text() / .json() / .lines() / .jsonl()` | Piped data |
| `pmap(items, fn, { concurrency })` | Bounded fan-out; use this instead of `Promise.all` |
| `sleep(ms)` | Polling loops |
| `emit(obj)` | Interim NDJSON event on stderr (not the return value) |
| `log(...)` | Human-readable stderr |
| `runId`, `calls` | Current run id; tool calls made so far |

## One-liners

```sh
dcompose eval '(await mcp.pagerduty.list_oncalls({})).response.map(o => o.user.summary)' -r --jsonl
dcompose call pagerduty.get_incident '{"incident_id":"Q123"}' | jq .response.title
```

## Guardrails

`run` and `eval` accept all of these; `call` accepts only `--read-only`.

- `--read-only` refuses tools not annotated readOnlyHint (exit 2). Use it unless you intend to write.
- `--allow 'pd.list_*,pd.get_*'` / `--deny 'pd.resolve_*'` limit which tools may be called.
- `--max-calls 50`, `--timeout 2m` bound the run. Defaults come from dcompose.json.
- `--dry-run` logs every call it would make and executes none. Use before any write.
- Results over `--max-output-bytes` (default 64k) are written to `.dcompose/runs/<id>.result.json`
  and stdout gets a small stub pointing at the file, with exit 2. Return less, or read the file.

## Long-running monitors

Poll in a loop and `return` only when something needs attention; process exit is the
notification. Run it in the background with no limits and relaunch after handling the result:

```sh
dcompose run watch-thing -i '{"ids":[...]}' --timeout 0 --max-calls 0 --read-only
```

## Do not

- Do not call `Promise.all` over hundreds of items; use `pmap`.
- Do not return whole records when a few fields answer the question.
- Do not guess argument names; read `.dcompose/types/mcp.d.ts` or probe with `dcompose call`.
- Do not parse stderr as data. Only stdout is the result.
