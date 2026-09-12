# Examples

Real scripts, written and run against a live PagerDuty MCP server during development. They
assume a server named `pagerduty` in your `dcompose.json`; adapt the server name and tool names
for your own setup. Run any of them with a path:

```sh
dcompose types                                    # so `import type { Ctx } from "dcompose"` resolves
dcompose check examples/incident-digest.ts
dcompose run examples/incident-digest.ts -i '{"days":7}' --read-only
```

| Script               | Shape                                  | What it shows                                                                                                                                                                             |
| -------------------- | -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `oncall-report.ts`   | four parallel lists, join in code      | Cross-entity join (on-calls → policies → services → incidents) with the fetched records never leaving the process. Written cold by an agent from the SKILL.md alone.                      |
| `incident-digest.ts` | paged list, aggregate, bounded fan-out | Paging past a server's 100-row cap by advancing `since`; per-service MTTR; `pmap` for note counts on the top services only. 830 KB fetched, 1.4 KB returned.                              |
| `watch-incidents.ts` | return-shape monitor                   | Polls, remembers seen state in `store`, baselines on first run, returns only when something changes. Run with `--timeout 0 --max-calls 0` in the background; process exit is the wake-up. |
| `stream-oncalls.ts`  | yield-shape stream                     | An `async function*`; every `yield` is one NDJSON line on stdout immediately.                                                                                                             |

The types these scripts compile against are generated from the server's declared schemas.
Where PagerDuty's declared output omitted fields that exist in real payloads (ids on nested
references), the scripts probe first with `dcompose call` and rely on the open output types.
