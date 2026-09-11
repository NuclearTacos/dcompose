import { Command, InvalidArgumentError } from "commander";
import { ConfigError, loadConfig } from "./config.ts";
import { ConnectionError, Registry } from "./client.ts";
import { ToolError } from "./result.ts";
import { EXIT } from "./output.ts";
import { serversCommand } from "./commands/servers.ts";
import { toolsCommand } from "./commands/tools.ts";
import { callCommand } from "./commands/call.ts";
import { initCommand } from "./commands/init.ts";
import { runCommand } from "./commands/run.ts";
import type { Config } from "./config.ts";

const program = new Command()
  .name("dcompose")
  .description("Compose MCP tool calls in code. stdout is data, stderr is everything else.")
  .version("0.1.0")
  .option("--config <path>", "config file (replaces the default lookup chain)")
  .option("-v, --verbose", "forward MCP server stderr")
  .configureOutput({ writeOut: (s) => process.stderr.write(s) });

interface GlobalOpts {
  config?: string;
  verbose?: boolean;
}

let loaded: Config | null = null;
function registry(): Registry {
  const g = program.opts<GlobalOpts>();
  const { config } = loadConfig({ explicitPath: g.config });
  loaded = config;
  return new Registry(config, { verbose: g.verbose });
}

async function run(fn: (r: Registry) => Promise<number>): Promise<void> {
  let r: Registry | null = null;
  let code: number;
  try {
    r = registry();
    code = await fn(r);
  } catch (e) {
    code = classify(e);
    process.stderr.write(`dcompose: ${(e as Error).message}\n`);
    if (program.opts<GlobalOpts>().verbose && (e as Error).stack) process.stderr.write((e as Error).stack + "\n");
  } finally {
    // Stdio children keep the event loop alive; close them and exit explicitly.
    await r?.closeAll();
  }
  process.exit(code);
}

function classify(e: unknown): number {
  if (e instanceof ConfigError || e instanceof ConnectionError) return EXIT.CONFIG;
  if (e instanceof ToolError) return EXIT.SCRIPT_ERROR;
  return EXIT.SCRIPT_ERROR;
}

function int(v: string): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw new InvalidArgumentError("expected a non-negative integer");
  return n;
}

program
  .command("init")
  .description("create dcompose.json and .dcompose/ in the current directory")
  .option("--import-claude", "copy stdio/http servers from ~/.claude.json and ./.mcp.json into dcompose.local.json")
  .option("--force", "overwrite existing imported entries")
  .action(async (opts) => process.exit(await initCommand(process.cwd(), opts)));

program
  .command("servers")
  .description("list configured servers with connection status and tool counts")
  .option("--json", "machine-readable output")
  .action((opts) => run((r) => serversCommand(r, opts)));

program
  .command("tools [server]")
  .description("list tools (server.tool, one-line description, [read-only] marker)")
  .option("-g, --grep <text>", "filter by substring in name or description")
  .option("--full", "include full descriptions and schemas")
  .option("--json", "machine-readable output with schemas")
  .action((server, opts) => run((r) => toolsCommand(r, { ...opts, server })));

program
  .command("call <server.tool> [json-args]")
  .description("call one tool. Args as JSON object, or '-' to read from stdin")
  .option("--args-file <path>", "read JSON args from a file ('-' for stdin)")
  .option("--raw", "print the unparsed MCP result envelope")
  .option("--jsonl", "if the result is an array, one JSON line per element")
  .option("-r, --raw-output", "print bare strings without JSON quotes")
  .option("-c, --compact", "single-line JSON even on a TTY")
  .option("--pretty", "indented JSON even when piped")
  .option("--timeout <ms>", "per-call timeout in milliseconds", int)
  .action((qualified, args, opts) => run((r) => callCommand(r, qualified, args, opts)));

const runFlags = (c: Command) =>
  c
    .option("-i, --input <json>", "input object for the script ('-' reads stdin)")
    .option("--input-file <path>", "read input JSON from a file")
    .option("--label <name>", "human label recorded in the run trace")
    .option("--timeout <dur>", "overall limit, e.g. 30s, 5m, 0 for none (default from config)")
    .option("--max-calls <n>", "tool-call budget, 0 for unlimited (default from config)", int)
    .option("--max-output-bytes <size>", "cap on the returned value, e.g. 64k; 0 for none", "64k")
    .option("--concurrency <n>", "default pmap concurrency", int)
    .option("--call-timeout <dur>", "per-tool-call timeout")
    .option("--allow <globs>", "comma-separated server.tool globs the script may call")
    .option("--deny <globs>", "comma-separated server.tool globs to refuse")
    .option("--read-only", "refuse tools not marked readOnlyHint")
    .option("--dry-run", "log calls, execute none, return null from each")
    .option("-q, --quiet", "suppress the run summary on stderr")
    .option("--jsonl", "if the result is an array, one JSON line per element")
    .option("-r, --raw-output", "print bare strings without JSON quotes")
    .option("-c, --compact", "single-line JSON even on a TTY")
    .option("--pretty", "indented JSON even when piped");

runFlags(
  program
    .command("run <script>")
    .description("run a script module: export default async (ctx) => value. Bare names resolve under .dcompose/scripts/"),
).action((script, opts) => run((r) => runCommand(r, loaded!, { script }, opts)));

runFlags(
  program
    .command("eval <code>")
    .description("run an inline expression or async body with the same context as run"),
).action((code, opts) => run((r) => runCommand(r, loaded!, { code }, opts)));

program.parseAsync(process.argv).catch((e) => {
  process.stderr.write(`dcompose: ${(e as Error).message}\n`);
  process.exit(EXIT.CONFIG);
});
