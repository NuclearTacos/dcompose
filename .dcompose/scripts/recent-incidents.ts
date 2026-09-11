// Scenario 1 shape: list → filter in code → fan out per-item lookups → return only what matters.
import type { Ctx } from "../../src/index.ts";

export default async function ({ mcp, pmap, input, log }: Ctx<{ limit?: number; status?: string[] }>) {
  const { response: incidents } = await mcp.pagerduty.list_incidents({
    statuses: input.status ?? ["resolved"],
    limit: input.limit ?? 5,
  });
  log(`fetched ${incidents.length}, fanning out for notes`);
  return pmap(incidents, async (i: any) => {
    const notes = await mcp.pagerduty.list_incident_notes({ incident_id: i.id });
    return { id: i.id, number: i.incident_number, title: i.title, status: i.status, notes: notes.response?.length ?? 0 };
  }, { concurrency: 4 });
}
