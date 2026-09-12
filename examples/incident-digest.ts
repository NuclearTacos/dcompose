// Seven-day PagerDuty digest per service: incident count, mean time to resolve, still-open count,
// and a bounded fan-out for note counts on the noisiest services' most recent incidents.
//
// Shape: list (paged) -> aggregate in code -> pmap fan-out -> return a compact table.
// Conventionally this would be 1 list call + N note calls each round-tripping through the model.
import type { Ctx } from "dcompose";

type Input = { days?: number; topServices?: number; notesPerService?: number };
// Pull the element type straight out of the generated signature so it tracks the server's schema.
type Incident = Awaited<ReturnType<Ctx["mcp"]["pagerduty"]["list_incidents"]>>["response"][number];

export default async function ({ mcp, pmap, input, log, emit }: Ctx<Input>) {
  const days = input.days ?? 7;
  const since = new Date(Date.now() - days * 86_400_000);

  // PagerDuty caps limit at 100 and this MCP exposes no offset, so page by advancing `since`
  // past the last incident seen. Incidents come back oldest-first.
  const incidents: Incident[] = [];
  let cursor = since.toISOString();
  for (let page = 1; ; page++) {
    const { response } = await mcp.pagerduty.list_incidents({ since: cursor, limit: 100 });
    const fresh = response.filter((i) => !incidents.some((k) => k.id === i.id));
    incidents.push(...fresh);
    emit({ kind: "page", page, got: response.length, total: incidents.length });
    if (response.length < 100 || fresh.length === 0) break;
    cursor = response[response.length - 1]!.created_at;
  }
  log(`${incidents.length} incidents since ${since.toISOString().slice(0, 10)}`);

  // Aggregate per service.
  type Agg = { service: string; count: number; open: number; resolveMinutes: number[]; recent: Incident[] };
  const byService = new Map<string, Agg>();
  for (const i of incidents) {
    const key = i.service.summary ?? i.service.id ?? "unknown";
    const s: Agg = byService.get(key) ?? { service: key, count: 0, open: 0, resolveMinutes: [], recent: [] };
    s.count++;
    if (i.status !== "resolved") s.open++;
    if (i.resolved_at) s.resolveMinutes.push((Date.parse(i.resolved_at) - Date.parse(i.created_at)) / 60_000);
    s.recent.push(i);
    byService.set(key, s);
  }

  const ranked = [...byService.values()].sort((a, b) => b.count - a.count);
  const top = ranked.slice(0, input.topServices ?? 5);

  // Fan out: note counts for the most recent N incidents of each top service. Bounded concurrency,
  // and only the count comes back, not the notes themselves.
  const perService = input.notesPerService ?? 3;
  const noteCounts = await pmap(
    top.flatMap((s) => s.recent.slice(-perService).map((i) => ({ service: s.service, id: i.id }))),
    async ({ service, id }) => ({
      service,
      notes: (await mcp.pagerduty.list_incident_notes({ incident_id: id })).response?.length ?? 0,
    }),
    { concurrency: 5 },
  );
  const notesByService = new Map<string, number>();
  for (const n of noteCounts) notesByService.set(n.service, (notesByService.get(n.service) ?? 0) + n.notes);

  const mean = (xs: number[]) => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : null);
  return {
    window: { days, since: since.toISOString(), incidents: incidents.length, services: byService.size },
    top: top.map((s) => ({
      service: s.service,
      incidents: s.count,
      open: s.open,
      mttrMinutes: mean(s.resolveMinutes),
      notesOnRecent: notesByService.get(s.service) ?? 0,
      latest: s.recent.at(-1)?.title.slice(0, 70),
    })),
    quietServices: ranked.slice(top.length).map((s) => `${s.service} (${s.count})`),
  };
}
