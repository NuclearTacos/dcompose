import { readFileSync } from "node:fs";
import type { Registry, Server } from "../client.ts";
import { ToolError } from "../result.ts";
import { emitResult, EXIT, type OutputOptions } from "../output.ts";
import { pmap } from "../runtime/pmap.ts";

export interface CallOptions extends OutputOptions {
  rawOutput?: boolean;
  argsFile?: string;
  readOnly?: boolean;
  timeout?: number;
  /** Read NDJSON arg objects from stdin, one call per line, NDJSON results out. */
  each?: boolean;
  concurrency?: number;
}

/**
 * The xargs of MCP: `... | dcompose call server.tool --each`. Each stdin line is an args object
 * (merged over any inline JSON as defaults). Output preserves input order; a failed call becomes
 * `{"error": "..."}` on its line and the exit code is 1 at the end.
 */
async function callEach(server: Server, tool: string, qualified: string, defaultsJson: string | undefined, opts: CallOptions): Promise<number> {
  const defaults = defaultsJson && defaultsJson !== "-" ? readArgs(defaultsJson, undefined) : {};
  const lines = readFileSync(0, "utf8")
    .split(/\r?\n/)
    .filter((l) => l.trim() !== "");
  let failures = 0;
  const results = await pmap(
    lines,
    async (line, i) => {
      let args: unknown;
      try {
        args = JSON.parse(line);
      } catch (e) {
        failures++;
        return { error: `line ${i + 1}: not JSON: ${(e as Error).message}` };
      }
      if (!args || typeof args !== "object" || Array.isArray(args)) {
        failures++;
        return { error: `line ${i + 1}: expected an object` };
      }
      try {
        return await server.callTool(tool, { ...defaults, ...(args as Record<string, unknown>) }, { raw: opts.raw, timeoutMs: opts.timeout });
      } catch (e) {
        failures++;
        return { error: e instanceof ToolError ? e.message : `${qualified}: ${(e as Error).message}` };
      }
    },
    { concurrency: opts.concurrency ?? 5 },
  );
  for (const r of results) process.stdout.write((opts.rawOutput && typeof r === "string" ? r : JSON.stringify(r)) + "\n");
  if (failures) process.stderr.write(`dcompose: ${failures} of ${lines.length} calls failed\n`);
  return failures ? EXIT.SCRIPT_ERROR : EXIT.OK;
}

export async function callCommand(registry: Registry, qualified: string, argsJson: string | undefined, opts: CallOptions): Promise<number> {
  const { server, tool } = registry.resolve(qualified);

  if (opts.readOnly) {
    const info = (await server.listTools()).find((t) => t.name === tool);
    if (!info) throw new Error(`${qualified}: unknown tool`);
    if (!info.readOnly) {
      process.stderr.write(`dcompose: ${qualified} is not marked readOnlyHint and --read-only is set\n`);
      return EXIT.GUARDRAIL;
    }
  }

  if (opts.each) return callEach(server, tool, qualified, argsJson, opts);

  const args = readArgs(argsJson, opts.argsFile);
  try {
    const value = await server.callTool(tool, args, { raw: opts.raw, timeoutMs: opts.timeout });
    emitResult(value, { ...opts, raw: opts.rawOutput });
    return EXIT.OK;
  } catch (e) {
    if (e instanceof ToolError) {
      process.stderr.write(`dcompose: ${e.message}\n`);
      return EXIT.SCRIPT_ERROR;
    }
    throw e;
  }
}

function readArgs(inline: string | undefined, file: string | undefined): Record<string, unknown> {
  let text: string | undefined;
  if (file) text = file === "-" ? readFileSync(0, "utf8") : readFileSync(file, "utf8");
  else if (inline === "-") text = readFileSync(0, "utf8");
  else text = inline;

  if (text === undefined || text.trim() === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new Error(`arguments are not valid JSON: ${(e as Error).message}`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("arguments must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}
