import type { Ctx } from "dcompose";

// Report: each on-call user (deduped), the escalation policy names they cover,
// and the count of open (triggered/acknowledged) incidents on those policies.
// Real MCP payloads carry `id` fields the generated types omit, so we widen to `any`.
export default async function ({ mcp, log }: Ctx<{ limit?: number }>) {
  const limit = 100; // PagerDuty API rejects limit > 100; MCP tools expose no offset, so results may be truncated at 100
  const [oncalls, policies, services, incidents] = await Promise.all([
    mcp.pagerduty.list_oncalls({ limit }),
    mcp.pagerduty.list_escalation_policies({ limit }),
    mcp.pagerduty.list_services({ limit }),
    mcp.pagerduty.list_incidents({ statuses: ["triggered", "acknowledged"], limit }),
  ]);

  const epName = new Map<string, string>();
  for (const p of policies.response as any[]) epName.set(p.id, p.name ?? p.summary ?? p.id);

  const serviceToEp = new Map<string, string>();
  for (const s of services.response as any[])
    if (s.escalation_policy?.id) serviceToEp.set(s.id, s.escalation_policy.id);

  // Open incidents per escalation policy id (via the incident's service).
  const openByEp = new Map<string, number>();
  let unmapped = 0;
  for (const i of incidents.response as any[]) {
    const ep = serviceToEp.get(i.service?.id);
    if (!ep) {
      unmapped++;
      continue;
    }
    openByEp.set(ep, (openByEp.get(ep) ?? 0) + 1);
  }

  // Dedupe on-calls by user id; collect the set of EP ids each covers.
  const users = new Map<string, { name: string; eps: Set<string> }>();
  for (const o of oncalls.response as any[]) {
    const uid = o.user?.id ?? o.user?.summary;
    if (!uid) continue;
    const u = users.get(uid) ?? { name: o.user.summary ?? uid, eps: new Set<string>() };
    if (o.escalation_policy?.id) u.eps.add(o.escalation_policy.id);
    users.set(uid, u);
  }

  log(
    `oncalls=${oncalls.response.length} policies=${policies.response.length} services=${services.response.length} openIncidents=${incidents.response.length} unmappedIncidents=${unmapped}`,
  );

  return [...users.values()]
    .map((u) => ({
      name: u.name,
      escalation_policies: [...u.eps].map((id) => epName.get(id) ?? id).sort(),
      open_incidents: [...u.eps].reduce((n, id) => n + (openByEp.get(id) ?? 0), 0),
    }))
    .sort((a, b) => b.open_incidents - a.open_incidents || a.name.localeCompare(b.name));
}
