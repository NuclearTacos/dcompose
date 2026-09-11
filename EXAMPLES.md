# dcompose — usage examples

Written from the agent's point of view: what Claude Code would actually type.

## Setup (once per project)

```sh
dcompose init                      # writes dcompose.json, .dcompose/, and .claude/skills/dcompose/SKILL.md
dcompose init --import-claude      # also copies stdio + header-auth servers from ~/.claude.json and ./.mcp.json
                                   #   → imported: pagerduty, chrome-devtools, datagrip
                                   #   → skipped (claude.ai connector, no local credentials): Microsoft 365, Notion, ...
dcompose servers
```

```
NAME             TRANSPORT  STATUS      TOOLS
pagerduty        stdio      connected   61
chrome-devtools  stdio      connected   27
datagrip         http       connected   41
teams            http       needs-auth  -      run: dcompose auth teams
```

```sh
dcompose auth teams                # opens browser, OAuth 2.1 + PKCE, tokens stored under ~/.dcompose/
```

## Discovering tools

```sh
dcompose tools pagerduty
```

```
pagerduty.list_incidents      List incidents, filterable by status/service/since   [read-only]
pagerduty.get_incident        Get one incident by id                               [read-only]
pagerduty.list_oncalls        Who is on call for a schedule/policy                 [read-only]
...
```

```sh
dcompose tools --grep incident            # substring filter across all servers
dcompose types                            # regenerates .dcompose/types/mcp.d.ts
```

The agent then reads `.dcompose/types/mcp.d.ts` for exact argument shapes:

```ts
declare namespace mcp.pagerduty {
  /** List incidents, filterable by status/service/since. */
  function list_incidents(args: {
    statuses?: ("triggered" | "acknowledged" | "resolved")[];
    service_ids?: string[];
    since?: string;
    limit?: number;
  }): Promise<any>;                        // no outputSchema on this server → any
}
```

## One-off call (debugging)

```sh
dcompose call pagerduty.list_incidents '{"statuses":["triggered"],"limit":3}'
dcompose call pagerduty.list_incidents '{"limit":1}' --raw     # unparsed MCP result envelope
```

## Scenario 1: fan-out and filter in code

Conventional approach: 1 list call + N record calls, each round-tripping through the model,
each full record landing in context. With dcompose:

```ts
// .dcompose/scripts/active-employee-names.ts
import type { Ctx } from "dcompose";  // resolves once phase 3 writes .dcompose/types/

export default async function ({ mcp, pmap }: Ctx) {
  const all = await mcp.hr.list_employees({});
  const active = all.filter((e: any) => e.active);
  const names = await pmap(active, (e: any) =>
    mcp.hr.get_employee({ id: e.id }).then((r: any) => r.name),
    { concurrency: 8 });
  return { count: names.length, names };
}
```

```sh
dcompose run .dcompose/scripts/active-employee-names.ts --read-only
```

stdout (the only thing that enters the agent's context):

```json
{"count":212,"names":["Ada Lovelace","Alan Turing", ...]}
```

stderr (visible to the agent only if it looks):

```
[dcompose] hr.list_employees            1 call    0.4s   118 KB
[dcompose] hr.get_employee            212 calls  6.2s   9.1 MB   (concurrency 8)
[dcompose] done in 6.7s · 213 calls · output 4.1 KB · run 20260911T140211Z-01J7QZ3M8KX4V9R2T6B1N5W0YD
```

Roughly 9 MB of tool output stayed out of the context window.

## Scenario 1 variant: cross-server join

```ts
// who is on call right now, and are any of their services currently triggered?
export default async function ({ mcp, pmap }: Ctx) {
  const oncalls = await mcp.pagerduty.list_oncalls({});
  const byUser = new Map<string, any>();
  for (const o of oncalls) byUser.set(o.user.id, { name: o.user.summary, policies: [] });
  for (const o of oncalls) byUser.get(o.user.id).policies.push(o.escalation_policy.summary);

  const triggered = await mcp.pagerduty.list_incidents({ statuses: ["triggered"] });
  return [...byUser.values()].map(u => ({
    ...u,
    open: triggered.filter((i: any) => u.policies.includes(i.escalation_policy?.summary)).length,
  }));
}
```

## Inputs from the agent

```sh
dcompose run scripts/incident-digest.ts --input '{"since":"2026-09-10T00:00:00Z","serviceIds":["PABC123"]}'
dcompose run scripts/incident-digest.ts --input-file /tmp/args.json
```

```ts
export default async function ({ mcp, input }: Ctx<{ since: string; serviceIds: string[] }>) {
  const incidents = await mcp.pagerduty.list_incidents({ since: input.since, service_ids: input.serviceIds });
  return incidents.map((i: any) => ({ id: i.id, title: i.title, status: i.status, urgency: i.urgency }));
}
```

## Scenario 2: long-running monitor

The script polls and **returns** only when something needs the agent. Process exit is the
notification; Claude Code re-invokes the agent when a background Bash command finishes.

```ts
// .dcompose/scripts/watch-teams.ts
export default async function ({ mcp, input, store, sleep, emit }: Ctx<{ watched: string[]; intervalMs?: number }>) {
  const seen: Record<string, string> = (await store.get("seen")) ?? {};

  while (true) {
    const chats = await mcp.teams.list_chats({});
    for (const c of chats) {
      if (seen[c.id] === c.lastMessageId) continue;
      const firstTime = !(c.id in seen);
      seen[c.id] = c.lastMessageId;
      await store.set("seen", seen);

      if (firstTime)                       return { kind: "new-chat", chatId: c.id, topic: c.topic, from: c.lastMessageFrom };
      if (input.watched.includes(c.id))    return { kind: "message",  chatId: c.id, topic: c.topic, preview: c.lastMessagePreview };
      emit({ kind: "unwatched-activity", chatId: c.id });
    }
    await sleep(input.intervalMs ?? 30_000);
  }
}
```

Agent runs it in the background with no timeout:

```sh
dcompose run .dcompose/scripts/watch-teams.ts \
  --input '{"watched":["19:abc@thread.v2","19:def@thread.v2"]}' \
  --timeout 0 --max-calls 0 --read-only
```

When it exits with `{"kind":"new-chat", ...}`, the agent asks the user "watch this one?",
updates the watched list, and relaunches. When it exits with `{"kind":"message", ...}`,
the agent summarises for the user and relaunches. `--max-calls 0` lifts the call cap because
a monitor legitimately makes thousands of calls over a day.

Alternative without relaunch: make the script an `async function*`. Each `yield` is printed
as one NDJSON line on stdout immediately and the process keeps running. Pair with Claude
Code's Monitor tool or a `tail -f`. Useful when relaunch cost (MCP cold start) is high and
the daemon is not yet available.

```ts
export default async function* ({ mcp, store, sleep }: Ctx<{ watched: string[] }>) {
  while (true) {
    for (const c of await mcp.teams.list_chats({})) {
      /* same seen/watched logic as above, but: */
      if (worthReporting) yield { kind: "message", chatId: c.id, preview: c.lastMessagePreview };
    }
    await sleep(30_000);
  }
}
```

```sh
dcompose run scripts/watch-teams.ts --input-file watched.json --timeout 8h --max-calls 0
```

## Safety flags in practice

```sh
dcompose run scripts/resolve-stale.ts --dry-run          # prints every call it *would* make, executes none
dcompose run scripts/resolve-stale.ts --allow 'pagerduty.list_*,pagerduty.get_*,pagerduty.resolve_incident'
dcompose run scripts/anything.ts --read-only             # refuses tools without readOnlyHint
dcompose run scripts/anything.ts --max-calls 50 --timeout 2m --max-output-bytes 16k
```

Exit codes the agent branches on:

```
0  script returned a value          → parse stdout
1  script threw                     → stderr has the stack; fix the script
2  guardrail hit                    → stderr says which (timeout / max-calls / denied tool / output cap)
3  config or connection error       → run `dcompose servers`
```

## Inspecting a past run

```sh
dcompose runs                                 # recent runs: id, label, script, calls, duration, exit code
dcompose runs show 20260911T140211Z-01J7      # any unique prefix; per-call trace: server, tool, args, duration, size
dcompose runs show --label nightly-digest     # or by the --label given at run time
dcompose runs show 20260911T140211Z-01J7 --jsonl | jq 'select(.duration_ms > 1000)'
```

Run IDs are `<UTC time>-<ULID>`, so many runs in one session sort chronologically and never
collide. The ID is printed on stderr at start and exposed as `ctx.runId` / `$DCOMPOSE_RUN_ID`.

## Mixing with other shell tools

stdout carries only the result, so dcompose slots into pipelines like any other filter.

```sh
# Pipe results into jq / grep / wc
dcompose call pagerduty.list_incidents '{"statuses":["triggered"]}' | jq -r '.[].title'
dcompose run scripts/active-employee-names.ts --jsonl | grep -i '^"a' | wc -l

# Feed stdin into a script
git log --since=yesterday --format='%H %s' | dcompose run scripts/link-commits-to-tickets.ts
```

```ts
// scripts/link-commits-to-tickets.ts — stdin lines in, enriched NDJSON out
export default async function ({ mcp, stdin, pmap }: Ctx) {
  const lines = await Array.fromAsync(stdin.lines());
  return pmap(lines, async (l) => {
    const [sha, ...rest] = l.split(" ");
    const key = rest.join(" ").match(/[A-Z]+-\d+/)?.[0];
    const issue = key ? await mcp.jira.get_issue({ key }) : null;
    return { sha, key, status: issue?.fields?.status?.name ?? null };
  }, { concurrency: 4 });
}
```

```sh
# xargs-style: one call per NDJSON line on stdin, results as NDJSON
dcompose call pagerduty.list_incidents '{"statuses":["triggered"]}' \
  | jq -c '.[] | {id}' \
  | dcompose call pagerduty.get_incident --each --concurrency 5 \
  | jq -r '[.id, .urgency, .title] | @tsv' \
  | column -t

# Inline one-liner, no script file
dcompose eval 'return (await mcp.pagerduty.list_oncalls({})).map(o => o.user.summary)' -r --jsonl | sort -u

# stdin as the input object
jq '{watched: [.[] | select(.watch) | .id]}' chats.json | dcompose run scripts/watch-teams.ts --input - --timeout 0

# Branch on exit code in a shell script
if out=$(dcompose run scripts/check.ts --read-only --max-calls 50); then
  echo "$out" | jq .
elif [ $? -eq 2 ]; then
  echo "hit a guardrail, see .dcompose/runs/$DCOMPOSE_RUN_ID.jsonl" >&2
fi

# Shelling out from inside a script (opt-in)
dcompose run scripts/deploy-check.ts --allow-exec
```

```ts
// scripts/deploy-check.ts — MCP data + a local CLI in one script
export default async function ({ mcp, sh }: Ctx) {
  const { stdout } = await sh("gh pr list --state merged --limit 20 --json number,mergedAt,title");
  const prs = JSON.parse(stdout);
  const incidents = await mcp.pagerduty.list_incidents({ since: prs.at(-1).mergedAt });
  return prs.map(p => ({ ...p, incidentsAfter: incidents.filter(i => i.created_at > p.mergedAt).length }));
}
```

## Later phases

```sh
dcompose daemon start                # keeps MCP connections warm; `run` uses it automatically
dcompose mcp                         # serve dcompose itself as an MCP server (search_tools, run_script)
```
