// Streaming shape: an async generator; each yield is one NDJSON line on stdout immediately.
import type { Ctx } from "dcompose";

export default async function* ({ mcp, sleep }: Ctx) {
  const { response } = await mcp.pagerduty.list_oncalls({ limit: 6 });
  for (const o of response) {
    yield { user: o.user?.summary, policy: o.escalation_policy?.id, level: o.escalation_level };
    await sleep(50);
  }
}
