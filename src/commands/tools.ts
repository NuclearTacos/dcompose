import type { Registry, ToolInfo } from "../client.ts";
import { emitResult, firstLine, table } from "../output.ts";

export interface ToolsOptions {
  server?: string;
  grep?: string;
  json?: boolean;
  full?: boolean;
}

export async function toolsCommand(registry: Registry, opts: ToolsOptions): Promise<number> {
  const servers = opts.server ? [registry.get(opts.server)] : registry.all();
  const errors: string[] = [];

  const lists = await Promise.all(
    servers.map(async (s) => {
      try {
        return await s.listTools();
      } catch (e) {
        errors.push((e as Error).message);
        return [] as ToolInfo[];
      }
    }),
  );

  let tools = lists.flat();
  if (opts.grep) {
    const needle = opts.grep.toLowerCase();
    tools = tools.filter((t) => `${t.server}.${t.name}`.toLowerCase().includes(needle) || (t.description ?? "").toLowerCase().includes(needle));
  }

  if (opts.json) {
    emitResult(
      tools.map((t) => ({
        server: t.server,
        name: t.name,
        description: t.description,
        readOnly: t.readOnly,
        annotations: t.annotations,
        inputSchema: t.inputSchema,
        outputSchema: t.outputSchema,
      })),
    );
  } else if (opts.full) {
    for (const t of tools) {
      process.stdout.write(`## ${t.server}.${t.name}${t.readOnly ? "  [read-only]" : ""}\n`);
      if (t.description) process.stdout.write(t.description.trim() + "\n");
      process.stdout.write("input: " + JSON.stringify(t.inputSchema) + "\n");
      if (t.outputSchema) process.stdout.write("output: " + JSON.stringify(t.outputSchema) + "\n");
      process.stdout.write("\n");
    }
  } else {
    const rows = tools.map((t) => [`${t.server}.${t.name}`, firstLine(t.description), t.readOnly ? "[read-only]" : ""]);
    if (rows.length) process.stdout.write(table(rows, { maxWidth: [60, 90, 12] }) + "\n");
  }

  for (const e of errors) process.stderr.write(`dcompose: ${e}\n`);
  return errors.length && tools.length === 0 ? 3 : 0;
}
