import type { Registry } from "../client.ts";
import { emitResult, table } from "../output.ts";

interface Row {
  name: string;
  transport: string;
  status: "connected" | "error";
  tools: number | null;
  serverName?: string;
  serverVersion?: string;
  error?: string;
}

export async function serversCommand(registry: Registry, opts: { json?: boolean; strict?: boolean }): Promise<number> {
  const rows: Row[] = await Promise.all(
    registry.all().map(async (s): Promise<Row> => {
      try {
        const tools = await s.listTools();
        const info = s.serverInfo();
        return {
          name: s.name,
          transport: s.transportKind,
          status: "connected",
          tools: tools.length,
          serverName: info?.name,
          serverVersion: info?.version,
        };
      } catch (e) {
        return { name: s.name, transport: s.transportKind, status: "error", tools: null, error: (e as Error).message };
      }
    }),
  );

  if (opts.json) {
    emitResult(rows);
  } else if (rows.length === 0) {
    process.stderr.write(
      "No servers configured. Run `dcompose init --import-claude` or add entries to dcompose.json.\n",
    );
  } else {
    const out = [["NAME", "TRANSPORT", "STATUS", "TOOLS", "SERVER"]];
    for (const r of rows) {
      out.push([
        r.name,
        r.transport,
        r.status,
        r.tools === null ? "-" : String(r.tools),
        r.serverName ? `${r.serverName} ${r.serverVersion ?? ""}`.trim() : "",
      ]);
    }
    process.stdout.write(table(out) + "\n");
    for (const r of rows) if (r.error) process.stderr.write(`\n${r.error}\n`);
  }

  // A status report that produced output is a success; one broken server is information, not
  // failure (an agent reading "non-zero = stop" would otherwise abandon a working setup).
  // --strict restores exit 3 on any error; all servers failing is always exit 3.
  const errors = rows.filter((r) => r.status === "error").length;
  if (errors === 0) return 0;
  if (opts.strict || errors === rows.length) return 3;
  process.stderr.write(
    `\n${errors} of ${rows.length} servers failed to connect (exit 0; use --strict to fail on this)\n`,
  );
  return 0;
}
