# dcompose pitfalls

Things that have actually gone wrong, and what to do instead.

## Output types are incomplete

The generated `.d.ts` reflects what the server _declares_, not what it returns. PagerDuty's
declared incident schema omitted `id` on nested references that the real payload carries.
Undeclared fields type as `any`, so `check` will not stop you, but a join on a field that is
not really there silently produces nothing.

Do: probe one real call before writing a join, and look at the actual keys.

```sh
dcompose call pagerduty.list_incidents '{"limit":1}' --read-only | jq '.response[0] | keys'
```

## List tools cap page size and hide it

PagerDuty rejects `limit > 100` with a 400 at run time; the input type says `number`. Other
servers silently truncate. A count that is exactly 100 is a warning sign.

Do: use `paginate` (patterns.md, pattern 3). Check the input type for `cursor`, `offset`, or
`page`, and fall back to advancing a timestamp when there is none.

## `--read-only` refuses tools that are not annotated

The flag trusts the server's `readOnlyHint`. A server that annotates nothing will have every
tool refused. A server that annotates wrongly will let a write through.

Do: check `dcompose tools <server>` for the `[read-only]` markers before relying on the flag.
If a read tool lacks the annotation, use `--allow 'server.that_tool'` instead.

## Dry-run returns `null`

`--dry-run` executes nothing and returns `null` from every call. A script that does
`const { response } = await mcp...` throws immediately. That is expected: dry-run is for seeing
the first call a write script would make, not for exercising the whole script.

Do: for a full rehearsal of a write script, run it read-only against the read half first, or
add `if (!result) return { dryRun: true }` after the first call.

## Hyphenated server names

`mcp.chrome-devtools.list_pages()` is a subtraction expression. Use bracket access:
`mcp["chrome-devtools"].list_pages()`, or `call("chrome-devtools.list_pages")`.

## The result was too big

Exit 2 with `{"$dcompose":"output-truncated", "file": ...}` on stdout means the return value
exceeded `--max-output-bytes` (64k default). The full value is in the file named.

Do: return fewer fields or a summary. Raising the cap defeats the purpose; the cap exists so a
script cannot dump a megabyte into your context by accident.

## Stale daemon after a config change

Commands detect a config-hash mismatch and ask the daemon to reload, but a daemon that was
killed hard leaves a stale record. The next command cleans it up and falls back to direct
connections. If behaviour looks stale anyway: `dcompose daemon stop && dcompose daemon start`.

## A server needs sign-in

"Server requires authentication. Run `dcompose auth <server>`" means the remote server wants
OAuth and no tokens are stored. This needs the user's browser; ask them to run it. After that,
every command uses the stored tokens and refreshes them silently.

## Script errors show only your frames

A stack trace from `run` is trimmed to lines in your script. If the top frame is inside a
tool call, the message is from the server; `--trace` or `dcompose runs show` tells you which
call and how long it took before failing.

## Guardrail exits are not bugs

Exit 2 means a limit you set was reached: the message names it (timeout, call budget, denied
tool, output cap, exec denied, max pages). Fix the script or raise the limit deliberately; do
not retry blindly.

## When dcompose is the wrong tool

- One call with a small result: call the tool directly.
- You need to read and reason about the records themselves, not summarise them.
- The server is a claude.ai-hosted connector with no local endpoint; dcompose cannot reach it.
