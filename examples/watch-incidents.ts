// Scenario 2 shape: poll, remember what was seen in the store, return only when something new appears.
import type { Ctx } from "dcompose";

type Seen = Record<string, string>; // incident id -> status

export default async function ({ mcp, store, sleep, emit, input }: Ctx<{ intervalMs?: number; statuses?: string[] }>) {
  const seen: Seen = (await store.get("seen")) ?? {};
  const first = Object.keys(seen).length === 0;

  while (true) {
    const { response } = await mcp.pagerduty.list_incidents({
      statuses: input.statuses ?? ["triggered", "acknowledged"],
      limit: 100,
    });
    const changes = [];
    for (const i of response) {
      const prev = seen[i.id];
      if (prev === i.status) continue;
      seen[i.id] = i.status;
      changes.push({
        id: i.id,
        number: i.incident_number,
        title: i.title,
        status: i.status,
        kind: prev ? "status-change" : "new",
      });
    }
    await store.set("seen", seen);

    if (first) {
      // Baseline pass: learn the current state without waking the agent for every existing incident.
      emit({ kind: "baseline", incidents: Object.keys(seen).length });
      return { kind: "baseline", tracked: Object.keys(seen).length };
    }
    if (changes.length) return { kind: "changes", changes };
    emit({ kind: "poll", open: response.length, changes: 0 });
    await sleep(input.intervalMs ?? 30_000);
  }
}
