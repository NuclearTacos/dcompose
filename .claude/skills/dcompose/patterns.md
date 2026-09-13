# dcompose script patterns

Every script is a module whose default export takes the context and returns the value to print.
`import type { Ctx } from "dcompose"` resolves once `dcompose types` has run. Server and tool
names below are examples; substitute your own from `dcompose tools`.

Choose by shape:

| You need to…                                | Pattern                  |
| ------------------------------------------- | ------------------------ |
| Call a tool once per item in a list         | 1. Fan-out               |
| Combine fields from two or more tools       | 2. Join                  |
| Get everything past a server's page cap     | 3. Paging                |
| Reduce many records to counts or averages   | 4. Aggregate             |
| Act on piped data from another command      | 5. Stdin pipeline        |
| Mix MCP data with a local CLI (git, gh, jq) | 6. Shell mix             |
| Wait for something to change, wake once     | 7. Monitor, return shape |
| Wait for changes, keep a feed running       | 8. Monitor, yield shape  |
| Write something, safely                     | 9. Guarded write         |
| Handle per-item failures without aborting   | 10. Partial failure      |

## 1. Fan-out

List, filter in code, call a second tool per survivor with bounded concurrency, return only the
fields that answer the question.

```ts
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
```

`dcompose run fanout -i '{"status":"acknowledged"}' --read-only --max-calls 120`

Concurrency 4 to 8 is usually right. Higher risks rate limits; the trace will show retries as
slow calls.

## 2. Join

Fetch each side once, index one side by key, walk the other. Never call a lookup tool inside
the loop when a list tool can fetch the whole side up front.

```ts
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
```

Three parallel list calls is fine with `Promise.all`; it is the per-item case that needs `pmap`.
Probe each side once with `dcompose call` first to confirm the join keys really exist (see
pitfalls.md, "output types are incomplete").

## 3. Paging

Servers cap page size and often expose no offset. Advance a cursor derived from the last item.
`paginate` handles the loop, the stop condition, and a runaway guard.

```ts
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
```

When the cursor is a timestamp, the boundary item can repeat on the next page; dedupe by id if
exact counts matter. If the server has a real `cursor` or `offset` input, use that instead.

## 4. Aggregate

Group in a `Map`, compute, return the table. Keep raw records out of the return value.

```ts
import type { Ctx } from "dcompose";

export default async function ({ mcp }: Ctx) {
  const { response } = await mcp.pagerduty.list_incidents({
    since: new Date(Date.now() - 7 * 86_400_000).toISOString(),
    limit: 100,
  });
  const by = new Map<string, { n: number; minutes: number[] }>();
  for (const i of response) {
    const k = i.service.summary ?? "unknown";
    const g = by.get(k) ?? { n: 0, minutes: [] };
    g.n++;
    if (i.resolved_at) g.minutes.push((Date.parse(i.resolved_at) - Date.parse(i.created_at)) / 60_000);
    by.set(k, g);
  }
  const mean = (xs: number[]) => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : null);
  return [...by]
    .map(([service, g]) => ({ service, incidents: g.n, mttrMinutes: mean(g.minutes) }))
    .sort((a, b) => b.incidents - a.incidents);
}
```

## 5. Stdin pipeline

Another command produces lines; the script enriches each one. Output stays JSON so it pipes on.

```ts
import type { Ctx } from "dcompose";

export default async function ({ mcp, stdin, pmap }: Ctx) {
  const lines = await Array.fromAsync(stdin.lines());
  return pmap(
    lines,
    async (line) => {
      const [sha, ...rest] = line.split(" ");
      const key = rest.join(" ").match(/[A-Z]+-\d+/)?.[0];
      const issue = key ? await mcp.jira.get_issue({ key }) : null;
      return { sha, key, status: issue?.fields?.status?.name ?? null };
    },
    { concurrency: 4 },
  );
}
```

`git log --since=yesterday --format='%H %s' | dcompose run link-commits --read-only --jsonl`

For one tool over many inputs with no logic, skip the script:
`jq -c '.[] | {key}' issues.json | dcompose call jira.get_issue --each`.

## 6. Shell mix

`sh()` runs a local command from inside the script. It needs `--allow-exec` and is traced as `$sh`.

```ts
import type { Ctx } from "dcompose";

export default async function ({ mcp, sh }: Ctx) {
  const { stdout } = await sh("gh pr list --state merged --limit 20 --json number,mergedAt,title", { check: true });
  const prs = JSON.parse(stdout) as { number: number; mergedAt: string; title: string }[];
  const since = prs.at(-1)!.mergedAt;
  const { response } = await mcp.pagerduty.list_incidents({ since, limit: 100 });
  return prs.map((p) => ({ ...p, incidentsAfter: response.filter((i) => i.created_at > p.mergedAt).length }));
}
```

`dcompose run deploy-check --allow-exec --read-only`

## 7. Monitor, return shape

Poll, remember what has been seen in `store`, return only when something needs attention.
Baseline on the first run so existing items do not all count as new. Run it in the background
with no limits; when it exits, handle the result and relaunch.

```ts
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
```

`dcompose run watch-incidents --timeout 0 --max-calls 0 --read-only -q` (with the Bash tool's
`run_in_background`). Reset with `rm .dcompose/state/watch-incidents.json`.

## 8. Monitor, yield shape

An `async function*`. Each `yield` is one NDJSON line on stdout immediately; the process keeps
running. Pair with a Monitor tool or `tail -f`.

```ts
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
```

`dcompose run triggered-feed --timeout 8h --max-calls 0 --read-only -q`

## 9. Guarded write

Never run a write script with `--read-only`; it will be refused. Instead: dry-run first, then
allow exactly the write tools by name, keep the call budget tight, and return what was changed.

```ts
import type { Ctx } from "dcompose";

export default async function ({ mcp, pmap, input }: Ctx<{ ids: string[]; note: string }>) {
  const results = await pmap(
    input.ids,
    async (id) => {
      await mcp.pagerduty.add_note_to_incident({ incident_id: id, content: input.note });
      return id;
    },
    { concurrency: 2 },
  );
  return { annotated: results };
}
```

```sh
dcompose run annotate -i '{"ids":["Q1","Q2"],"note":"acknowledged in standup"}' --dry-run
dcompose run annotate -i '{"ids":["Q1","Q2"],"note":"acknowledged in standup"}' --allow 'pagerduty.add_note_to_incident' --max-calls 5
```

Dry-run returns `null` from every call, so a script that destructures a result will throw on
the first one. That still shows you the first call it would make, which is often enough.

## 10. Partial failure

`pmap` rejects on the first error by default. Pass `{ settle: true }` to get `{ error }`
entries instead, then report both halves.

```ts
import type { Ctx } from "dcompose";

export default async function ({ mcp, pmap, input }: Ctx<{ ids: string[] }>) {
  const out = await pmap(input.ids, (id) => mcp.pagerduty.get_incident({ incident_id: id }), {
    concurrency: 5,
    settle: true,
  });
  const ok = out.filter((r: any) => !r.error).map((r: any) => ({ id: r.response.id, status: r.response.status }));
  const failed = out.map((r: any, i) => (r.error ? { id: input.ids[i], error: r.error } : null)).filter(Boolean);
  return { ok, failed };
}
```
