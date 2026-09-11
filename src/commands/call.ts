import { readFileSync } from "node:fs";
import type { Registry } from "../client.ts";
import { ToolError } from "../result.ts";
import { emitResult, EXIT, type OutputOptions } from "../output.ts";

export interface CallOptions extends OutputOptions {
  rawOutput?: boolean;
  argsFile?: string;
  readOnly?: boolean;
  timeout?: number;
}

export async function callCommand(registry: Registry, qualified: string, argsJson: string | undefined, opts: CallOptions): Promise<number> {
  const { server, tool } = registry.resolve(qualified);
  const args = readArgs(argsJson, opts.argsFile);

  if (opts.readOnly) {
    const info = (await server.listTools()).find((t) => t.name === tool);
    if (!info) throw new Error(`${qualified}: unknown tool`);
    if (!info.readOnly) {
      process.stderr.write(`dcompose: ${qualified} is not marked readOnlyHint and --read-only is set\n`);
      return EXIT.GUARDRAIL;
    }
  }

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
