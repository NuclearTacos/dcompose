/**
 * Skill files written by `dcompose init` into .claude/skills/dcompose/.
 *
 * SKILL.md is loaded into the agent's context whenever the skill triggers, so it stays short:
 * the workflow, the rules, and pointers. The companion files are read on demand when the agent
 * is writing a new script shape (patterns.md) or hits a problem (pitfalls.md).
 */
export function skillFiles(): Record<string, string> {
  return {
    "SKILL.md": skillMarkdown(),
    "patterns.md": patternsMarkdown(),
    "pitfalls.md": pitfallsMarkdown(),
  };
}

export function skillMarkdown(): string {
  return `---
name: dcompose
description: Compose several MCP tool calls in one TypeScript script instead of one tool call per turn. Use when a task needs a list-then-lookup fan-out, cross-server joins, filtering large tool results down to a few fields, paging past a server's row cap, polling/monitoring until a condition is met, or any chain of 3+ tool calls where intermediate data does not need to be seen. Also use when a needed MCP server is configured in dcompose but not available as a native tool.
---

# dcompose

Run MCP tool calls from a script so only the final value enters your context. stdout is the
result as JSON. stderr is logs and a run summary. Exit codes: 0 ok, 1 script or tool error,
2 guardrail hit (timeout, call budget, denied tool, output cap), 3 config or connection error.

One \`dcompose run\` is one shell command: one permission check and one round-trip for the whole
script, however many tool calls it makes. That is why the guardrail flags below matter.

Companion files in this folder, read them when relevant:
- **patterns.md**: complete, runnable script shapes (fan-out, join, paging, aggregate, monitor,
  stream, stdin pipeline, shell mix). Start from the closest one instead of from scratch.
- **pitfalls.md**: what has actually gone wrong and how to avoid it. Read it the first time a
  run fails for a reason you did not expect.

## Config, in one breath

Servers come from three files merged in order: \`~/.dcompose/config.json\` (user), then
\`./dcompose.json\`, then \`./dcompose.local.json\`. Entries use Claude Code's \`mcpServers\` shape;
\`\${VAR}\` and \`\${VAR:-default}\` expand from the environment. \`dcompose where\` shows which files
are in effect.

**Need a server Claude Code has but dcompose does not?** Copy it into the user-level config;
nothing is written to the current directory:
\`\`\`sh
dcompose import --list            # what Claude Code has
dcompose import pagerduty         # → ~/.dcompose/config.json
\`\`\`
**Do not run \`dcompose init\` inside a repo you do not own.** It creates \`dcompose.json\`,
\`.dcompose/\`, and (with \`--import-claude\`) a \`dcompose.local.json\` that carries API keys copied
from Claude Code's config. \`init\` is for a project that should own its dcompose setup.

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

0. **Find your paths.** \`dcompose where\` prints the scripts, runs, state, and types locations
   for this directory. A directory with its own \`dcompose.json\` uses \`./.dcompose/\`; one running
   on user-level config alone uses a workspace under \`~/.dcompose/workspaces/\` so the directory
   is never written to. Write scripts to the \`scripts\` path it prints; bare names in \`run\`
   resolve there.
1. **See what is available.**
   \`\`\`sh
   dcompose servers                      # names, connection status, tool counts
   dcompose tools <server> --grep <word> # server.tool + one-line description + [read-only]
   \`\`\`
   Note which tools carry \`[read-only]\`. Servers that annotate nothing (common) make
   \`--read-only\` refuse everything; use \`--allow\` with explicit tool names for those.
2. **Read the exact signatures.** \`dcompose types\` writes the \`types\` file that
   \`dcompose where\` reported. Grep it for the tool name instead of guessing argument names.
   Input types are exact. (If an unrelated server fails to connect, types are still written for
   the rest; the command says so and exits 0.)
   **Output types are only as good as the server's declared schema**: they often omit fields
   that are really there, and tools with no schema return \`any\`. Before joining on a field,
   probe one real call:
   \`\`\`sh
   dcompose call <server>.<tool> '{"limit":2}' --read-only
   \`\`\`
3. **Write the script.** \`dcompose new <name>\` scaffolds it at the \`scripts\` path from
   \`dcompose where\` and prints the path. A script is a module whose default export takes the
   context and returns the value to print; nothing else works (no top-level \`await\`, no bare
   \`return\`):
   \`\`\`ts
   import type { Ctx } from "dcompose";
   export default async function ({ mcp, pmap, unwrap, input }: Ctx<{ limit?: number }>) {
     const { response } = await mcp.someServer.list_things({ limit: input.limit ?? 100 });
     return response.map((r) => ({ id: r.id, name: r.name }));
   }
   \`\`\`
   Copy the closest shape from patterns.md. Return only what you need; anything you return
   lands in your context.
4. **Type-check, then run.**
   \`\`\`sh
   dcompose check <name>
   dcompose run <name> -i '{"limit":10}' --read-only       # bare name resolves under .dcompose/scripts/
   \`\`\`
5. **Iterate.** A non-zero exit prints the reason on stderr. Script bugs show the frame in your
   file. Add \`--trace\` to watch each call as it happens. \`dcompose runs show\` replays the last run.

## Context passed to the script

| Member | Use |
|---|---|
| \`mcp.<server>.<tool>(args)\` | Call a tool; result is parsed JSON. Hyphenated names: \`mcp["chrome-devtools"].list_pages()\` |
| \`mcp.<server>.raw.<tool>(args)\` | Unparsed MCP envelope when auto-parse is wrong |
| \`call("server.tool", args)\` | Same as above by string name |
| \`input\` | From \`-i '<json>'\`, \`--input-file <path>\`, or \`-i -\` (stdin) |
| \`stdin.text() / .json() / .lines() / .jsonl()\` | Piped data |
| \`pmap(items, fn, { concurrency })\` | Bounded fan-out; use this instead of \`Promise.all\` |
| \`paginate(async (cursor) => ({ items, next }), { maxPages })\` | Cursor paging; returns all items |
| \`sleep(ms)\` | Polling loops |
| \`unwrap(value)\` | Parse JSON a server returned inside a string field. Pass the whole result or just the string; both work: \`unwrap(await mcp.pd.get_metrics(w)).result.total\`. \`dcompose call\` prints a note when a result needs this |
| \`emit(obj)\` | Interim NDJSON event on stderr (not the return value) |
| \`log(...)\` | Human-readable stderr |
| \`store.get/set/delete/all\` | JSON state persisted at \`.dcompose/state/<script>.json\` across runs |
| \`sh(cmd)\` | Shell command; only with \`--allow-exec\` |
| \`runId\`, \`calls\` | Current run id; tool calls made so far |

## Guardrails

\`run\` and \`eval\` accept all of these; \`call\` accepts only \`--read-only\`.

- \`--read-only\` refuses tools not annotated readOnlyHint (exit 2). Use it unless you intend to write.
- \`--allow 'pd.list_*,pd.get_*'\` / \`--deny 'pd.resolve_*'\` limit which tools may be called.
- \`--max-calls 50\`, \`--timeout 2m\` bound the run. Defaults come from dcompose.json.
- \`--dry-run\` logs every call it would make and executes none. Use before any write.
- \`--trace\` streams each tool call to stderr as it happens; useful on long or stuck runs.
- Results over \`--max-output-bytes\` (default 64k) are written to \`.dcompose/runs/<id>.result.json\`
  and stdout gets a small stub pointing at the file, with exit 2. Return less, or read the file.

Pick flags by intent: **read-only report** → \`--read-only --max-calls N\` when the tools carry
\`[read-only]\`, otherwise \`--allow 'srv.list_*,srv.get_*' --max-calls N\`. **Write action** →
first \`--dry-run\`, then \`--allow\` naming exactly the write tools, never \`--read-only\`.
**Monitor** → \`--timeout 0 --max-calls 0 --read-only -q\`.

## One-liners

\`\`\`sh
dcompose eval '(await mcp.pagerduty.list_oncalls({})).response.map(o => o.user.summary)' -r --jsonl
dcompose call pagerduty.get_incident '{"incident_id":"Q123"}' | jq .response.title
jq -c '.[] | {id}' items.json | dcompose call server.get_thing --each --concurrency 5
\`\`\`

## Long-running monitors

**Return shape**: poll, remember state in \`store\`, \`return\` only when something needs
attention. Run in the background; process exit is the notification; relaunch after handling.
**Yield shape**: \`async function*\`; every \`yield\` is one NDJSON line on stdout immediately.
Both are written out in full in patterns.md.

## Remote servers that need sign-in

If a server fails with "requires authentication", run \`dcompose auth <server>\` once. It opens a
browser for OAuth and stores tokens; later commands use them silently. Ask the user to do this
step, since it needs their browser session.

## Speed: start the daemon once per session

Each command normally spawns the MCP servers fresh (seconds for \`uvx\`/\`npx\` servers). A
per-project daemon keeps them connected; every command uses it automatically when running.

\`\`\`sh
dcompose daemon start      # once; exits itself after 1h idle
\`\`\`

## Do not

- Do not call \`Promise.all\` over hundreds of items; use \`pmap\`.
- Do not return whole records when a few fields answer the question.
- Do not guess argument names; read \`.dcompose/types/mcp.d.ts\` or probe with \`dcompose call\`.
- Do not parse stderr as data. Only stdout is the result.
- Do not hand-roll paging loops; use \`paginate\`.
`;
}

export function patternsMarkdown(): string {
  return `# dcompose script patterns

Every script is a module whose default export takes the context and returns the value to print.
\`import type { Ctx } from "dcompose"\` resolves once \`dcompose types\` has run. Server and tool
names below are examples; substitute your own from \`dcompose tools\`.

Choose by shape:

| You need to… | Pattern |
|---|---|
| Call a tool once per item in a list | 1. Fan-out |
| Combine fields from two or more tools | 2. Join |
| Get everything past a server's page cap | 3. Paging |
| Reduce many records to counts or averages | 4. Aggregate |
| Act on piped data from another command | 5. Stdin pipeline |
| Mix MCP data with a local CLI (git, gh, jq) | 6. Shell mix |
| Wait for something to change, wake once | 7. Monitor, return shape |
| Wait for changes, keep a feed running | 8. Monitor, yield shape |
| Write something, safely | 9. Guarded write |
| Handle per-item failures without aborting | 10. Partial failure |

## 1. Fan-out

List, filter in code, call a second tool per survivor with bounded concurrency, return only the
fields that answer the question.

\`\`\`ts
import type { Ctx } from "dcompose";

export default async function ({ mcp, pmap, input }: Ctx<{ status?: string }>) {
  const { response } = await mcp.pagerduty.list_incidents({ statuses: [input.status ?? "triggered"], limit: 100 });
  return pmap(
    response,
    async (i) => {
      const notes = await mcp.pagerduty.list_incident_notes({ incident_id: i.id });
      return { id: i.id, title: i.title, notes: notes.response.length };
    },
    { concurrency: 5 },
  );
}
\`\`\`

\`dcompose run fanout -i '{"status":"acknowledged"}' --read-only --max-calls 120\`

Concurrency 4 to 8 is usually right. Higher risks rate limits; the trace will show retries as
slow calls.

## 2. Join

Fetch each side once, index one side by key, walk the other. Never call a lookup tool inside
the loop when a list tool can fetch the whole side up front.

\`\`\`ts
import type { Ctx } from "dcompose";

export default async function ({ mcp }: Ctx) {
  const [oncalls, incidents, services] = await Promise.all([
    mcp.pagerduty.list_oncalls({ limit: 100 }),
    mcp.pagerduty.list_incidents({ statuses: ["triggered", "acknowledged"], limit: 100 }),
    mcp.pagerduty.list_services({ limit: 100 }),
  ]);
  // Incidents carry a service id; services carry an escalation policy id; on-calls carry a policy id.
  const policyOfService = new Map(services.response.map((s) => [s.id, s.escalation_policy?.id]));
  const openByPolicy = new Map<string, number>();
  for (const i of incidents.response) {
    const p = policyOfService.get(i.service.id);
    if (p) openByPolicy.set(p, (openByPolicy.get(p) ?? 0) + 1);
  }
  const byUser = new Map<string, { name: string; open: number }>();
  for (const o of oncalls.response) {
    const u = byUser.get(o.user.id) ?? { name: o.user.summary ?? o.user.id, open: 0 };
    u.open += openByPolicy.get(o.escalation_policy.id) ?? 0;
    byUser.set(o.user.id, u);
  }
  return [...byUser.values()].sort((a, b) => b.open - a.open);
}
\`\`\`

Three parallel list calls is fine with \`Promise.all\`; it is the per-item case that needs \`pmap\`.
Probe each side once with \`dcompose call\` first to confirm the join keys really exist (see
pitfalls.md, "output types are incomplete").

## 3. Paging

Servers cap page size and often expose no offset. Advance a cursor derived from the last item.
\`paginate\` handles the loop, the stop condition, and a runaway guard.

\`\`\`ts
import type { Ctx } from "dcompose";

export default async function ({ mcp, paginate, input }: Ctx<{ days?: number }>) {
  const since = new Date(Date.now() - (input.days ?? 7) * 86_400_000).toISOString();
  const incidents = await paginate<any, string>(
    async (cursor) => {
      const { response } = await mcp.pagerduty.list_incidents({ since: cursor ?? since, limit: 100 });
      return { items: response, next: response.length === 100 ? response.at(-1)!.created_at : null };
    },
    { maxPages: 50 },
  );
  return { count: incidents.length, oldest: incidents[0]?.created_at, newest: incidents.at(-1)?.created_at };
}
\`\`\`

When the cursor is a timestamp, the boundary item can repeat on the next page; dedupe by id if
exact counts matter. If the server has a real \`cursor\` or \`offset\` input, use that instead.

## 4. Aggregate

Group in a \`Map\`, compute, return the table. Keep raw records out of the return value.

\`\`\`ts
import type { Ctx } from "dcompose";

export default async function ({ mcp }: Ctx) {
  const { response } = await mcp.pagerduty.list_incidents({ since: new Date(Date.now() - 7 * 86_400_000).toISOString(), limit: 100 });
  const by = new Map<string, { n: number; minutes: number[] }>();
  for (const i of response) {
    const k = i.service.summary ?? "unknown";
    const g = by.get(k) ?? { n: 0, minutes: [] };
    g.n++;
    if (i.resolved_at) g.minutes.push((Date.parse(i.resolved_at) - Date.parse(i.created_at)) / 60_000);
    by.set(k, g);
  }
  const mean = (xs: number[]) => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : null);
  return [...by].map(([service, g]) => ({ service, incidents: g.n, mttrMinutes: mean(g.minutes) })).sort((a, b) => b.incidents - a.incidents);
}
\`\`\`

## 5. Stdin pipeline

Another command produces lines; the script enriches each one. Output stays JSON so it pipes on.

\`\`\`ts
import type { Ctx } from "dcompose";

export default async function ({ mcp, stdin, pmap }: Ctx) {
  const lines = await Array.fromAsync(stdin.lines());
  return pmap(
    lines,
    async (line) => {
      const [sha, ...rest] = line.split(" ");
      const key = rest.join(" ").match(/[A-Z]+-\\d+/)?.[0];
      const issue = key ? await mcp.jira.get_issue({ key }) : null;
      return { sha, key, status: issue?.fields?.status?.name ?? null };
    },
    { concurrency: 4 },
  );
}
\`\`\`

\`git log --since=yesterday --format='%H %s' | dcompose run link-commits --read-only --jsonl\`

For one tool over many inputs with no logic, skip the script:
\`jq -c '.[] | {key}' issues.json | dcompose call jira.get_issue --each\`.

## 6. Shell mix

\`sh()\` runs a local command from inside the script. It needs \`--allow-exec\` and is traced as \`$sh\`.

\`\`\`ts
import type { Ctx } from "dcompose";

export default async function ({ mcp, sh }: Ctx) {
  const { stdout } = await sh("gh pr list --state merged --limit 20 --json number,mergedAt,title", { check: true });
  const prs = JSON.parse(stdout) as { number: number; mergedAt: string; title: string }[];
  const since = prs.at(-1)!.mergedAt;
  const { response } = await mcp.pagerduty.list_incidents({ since, limit: 100 });
  return prs.map((p) => ({ ...p, incidentsAfter: response.filter((i) => i.created_at > p.mergedAt).length }));
}
\`\`\`

\`dcompose run deploy-check --allow-exec --read-only\`

## 7. Monitor, return shape

Poll, remember what has been seen in \`store\`, return only when something needs attention.
Baseline on the first run so existing items do not all count as new. Run it in the background
with no limits; when it exits, handle the result and relaunch.

\`\`\`ts
import type { Ctx } from "dcompose";

export default async function ({ mcp, store, sleep, emit, input }: Ctx<{ intervalMs?: number }>) {
  const seen: Record<string, string> = (await store.get("seen")) ?? {};
  const first = Object.keys(seen).length === 0;
  while (true) {
    const { response } = await mcp.pagerduty.list_incidents({ statuses: ["triggered", "acknowledged"], limit: 100 });
    const changes = [];
    for (const i of response) {
      if (seen[i.id] === i.status) continue;
      changes.push({ id: i.id, title: i.title, status: i.status, kind: seen[i.id] ? "status-change" : "new" });
      seen[i.id] = i.status;
    }
    await store.set("seen", seen);
    if (first) return { kind: "baseline", tracked: Object.keys(seen).length };
    if (changes.length) return { kind: "changes", changes };
    emit({ kind: "poll", open: response.length });
    await sleep(input.intervalMs ?? 30_000);
  }
}
\`\`\`

\`dcompose run watch-incidents --timeout 0 --max-calls 0 --read-only -q\` (with the Bash tool's
\`run_in_background\`). Reset with \`rm .dcompose/state/watch-incidents.json\`.

## 8. Monitor, yield shape

An \`async function*\`. Each \`yield\` is one NDJSON line on stdout immediately; the process keeps
running. Pair with a Monitor tool or \`tail -f\`.

\`\`\`ts
import type { Ctx } from "dcompose";

export default async function* ({ mcp, sleep }: Ctx) {
  let last = 0;
  while (true) {
    const { response } = await mcp.pagerduty.list_incidents({ statuses: ["triggered"], limit: 100 });
    if (response.length !== last) yield { at: new Date().toISOString(), triggered: response.length };
    last = response.length;
    await sleep(60_000);
  }
}
\`\`\`

\`dcompose run triggered-feed --timeout 8h --max-calls 0 --read-only -q\`

## 9. Guarded write

Never run a write script with \`--read-only\`; it will be refused. Instead: dry-run first, then
allow exactly the write tools by name, keep the call budget tight, and return what was changed.

\`\`\`ts
import type { Ctx } from "dcompose";

export default async function ({ mcp, pmap, input }: Ctx<{ ids: string[]; note: string }>) {
  const results = await pmap(input.ids, async (id) => {
    await mcp.pagerduty.add_note_to_incident({ incident_id: id, content: input.note });
    return id;
  }, { concurrency: 2 });
  return { annotated: results };
}
\`\`\`

\`\`\`sh
dcompose run annotate -i '{"ids":["Q1","Q2"],"note":"acknowledged in standup"}' --dry-run
dcompose run annotate -i '{"ids":["Q1","Q2"],"note":"acknowledged in standup"}' --allow 'pagerduty.add_note_to_incident' --max-calls 5
\`\`\`

Dry-run returns \`null\` from every call, so a script that destructures a result will throw on
the first one. That still shows you the first call it would make, which is often enough.

## 10. Partial failure

\`pmap\` rejects on the first error by default. Pass \`{ settle: true }\` to get \`{ error }\`
entries instead, then report both halves.

\`\`\`ts
import type { Ctx } from "dcompose";

export default async function ({ mcp, pmap, input }: Ctx<{ ids: string[] }>) {
  const out = await pmap(input.ids, (id) => mcp.pagerduty.get_incident({ incident_id: id }), { concurrency: 5, settle: true });
  const ok = out.filter((r: any) => !r.error).map((r: any) => ({ id: r.response.id, status: r.response.status }));
  const failed = out.map((r: any, i) => (r.error ? { id: input.ids[i], error: r.error } : null)).filter(Boolean);
  return { ok, failed };
}
\`\`\`
`;
}

export function pitfallsMarkdown(): string {
  return `# dcompose pitfalls

Things that have actually gone wrong, and what to do instead.

## Output types are incomplete

The generated \`.d.ts\` reflects what the server *declares*, not what it returns. PagerDuty's
declared incident schema omitted \`id\` on nested references that the real payload carries.
Undeclared fields type as \`any\`, so \`check\` will not stop you, but a join on a field that is
not really there silently produces nothing.

Do: probe one real call before writing a join, and look at the actual keys.
\`\`\`sh
dcompose call pagerduty.list_incidents '{"limit":1}' --read-only | jq '.response[0] | keys'
\`\`\`

## The result is JSON inside a string

Some servers return \`{ "result": "{\\"total\\":24725,...}" }\`: the payload is a JSON string in a
field. Auto-parse cannot know that string is JSON, so scripts see text, and the generated type
for that field honestly says \`string\`. PagerDuty's analytics tools do this.

Do: \`dcompose call\` prints a note naming the field when this happens. In the script, wrap the
call: \`const m = unwrap(await mcp.pagerduty.get_incident_metrics_all(win))\` and then read
\`m.result.total_incident_count\`. \`unwrap\` recurses, leaves ordinary text alone, and is a
no-op on values that were already objects. Probe the unwrapped shape once before writing the
join; the by-service variant carries \`response: [...]\`, not \`data\`.

## \`dcompose init\` in a repo you do not own

\`init\` creates \`dcompose.json\` and \`.dcompose/\` in the current directory, and
\`--import-claude\` writes \`dcompose.local.json\` with API keys copied from Claude Code's config.
In a shared repo that is a secret on disk and untracked files in someone else's tree. \`init\` now
adds the ignore rules to the repo's \`.gitignore\` itself and reports exactly what git will do, but
the right move is not to run it there at all.

Do: \`dcompose import <server>\` (user-level config, nothing written here) and \`dcompose where\`
to find the workspace paths. Use \`init\` only in a project that should own its dcompose setup.

## List tools cap page size and hide it

PagerDuty rejects \`limit > 100\` with a 400 at run time; the input type says \`number\`. Other
servers silently truncate. A count that is exactly 100 is a warning sign.

Do: use \`paginate\` (patterns.md, pattern 3). Check the input type for \`cursor\`, \`offset\`, or
\`page\`, and fall back to advancing a timestamp when there is none.

## \`--read-only\` refuses tools that are not annotated

The flag trusts the server's \`readOnlyHint\`. A server that annotates nothing will have every
tool refused. A server that annotates wrongly will let a write through.

Do: check \`dcompose tools <server>\` for the \`[read-only]\` markers before relying on the flag.
If a read tool lacks the annotation, use \`--allow 'server.that_tool'\` instead.

## Dry-run returns \`null\`

\`--dry-run\` executes nothing and returns \`null\` from every call. A script that does
\`const { response } = await mcp...\` throws immediately. That is expected: dry-run is for seeing
the first call a write script would make, not for exercising the whole script.

Do: for a full rehearsal of a write script, run it read-only against the read half first, or
add \`if (!result) return { dryRun: true }\` after the first call.

## Hyphenated server names

\`mcp.chrome-devtools.list_pages()\` is a subtraction expression. Use bracket access:
\`mcp["chrome-devtools"].list_pages()\`, or \`call("chrome-devtools.list_pages")\`.

## The result was too big

Exit 2 with \`{"$dcompose":"output-truncated", "file": ...}\` on stdout means the return value
exceeded \`--max-output-bytes\` (64k default). The full value is in the file named.

Do: return fewer fields or a summary. Raising the cap defeats the purpose; the cap exists so a
script cannot dump a megabyte into your context by accident.

## Stale daemon after a config change

Commands detect a config-hash mismatch and ask the daemon to reload, but a daemon that was
killed hard leaves a stale record. The next command cleans it up and falls back to direct
connections. If behaviour looks stale anyway: \`dcompose daemon stop && dcompose daemon start\`.

## A server needs sign-in

"Server requires authentication. Run \`dcompose auth <server>\`" means the remote server wants
OAuth and no tokens are stored. This needs the user's browser; ask them to run it. After that,
every command uses the stored tokens and refreshes them silently.

## Script errors show only your frames

A stack trace from \`run\` is trimmed to lines in your script. If the top frame is inside a
tool call, the message is from the server; \`--trace\` or \`dcompose runs show\` tells you which
call and how long it took before failing.

## Guardrail exits are not bugs

Exit 2 means a limit you set was reached: the message names it (timeout, call budget, denied
tool, output cap, exec denied, max pages). Fix the script or raise the limit deliberately; do
not retry blindly.

## When dcompose is the wrong tool

- One call with a small result: call the tool directly.
- You need to read and reason about the records themselves, not summarise them.
- The server is a claude.ai-hosted connector with no local endpoint; dcompose cannot reach it.
`;
}
