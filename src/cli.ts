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
import { typesCommand } from "./commands/types.ts";
import { checkCommand } from "./commands/check.ts";
import { runsListCommand, runsShowCommand } from "./commands/runs.ts";
import { daemonLog, daemonRun, daemonStart, daemonStatus, daemonStop, ensureDaemon } from "./commands/daemon.ts";
import { DaemonClient } from "./daemon/client.ts";
import { configHash, findProjectRoot, type Config } from "./config.ts";

const program = new Command()
  .name("dcompose")
  .description("Compose MCP tool calls in code. stdout is data, stderr is everything else.")
  .version("0.1.0")
  .option("--config <path>", "config file (replaces the default lookup chain)")
  .option("-v, --verbose", "forward MCP server stderr")
  .option("--no-daemon", "connect to MCP servers directly even if a daemon is running")
  .showHelpAfterError("(run the subcommand with --help to see its options)")
  .showSuggestionAfterError()
  .configureOutput({ writeOut: (s) => process.stderr.write(s) });

interface GlobalOpts {
  config?: string;
  verbose?: boolean;
  /** Commander: --no-daemon sets this to false; default true. */
  daemon?: boolean;
}

let loaded: Config | null = null;
let daemonClient: DaemonClient | null = null;

/**
 * Build the registry. If a daemon is running for this project (or config says autoStart),
 * every server is delegated to it; otherwise servers connect directly as before.
 * `--no-daemon`, `DCOMPOSE_NO_DAEMON=1`, or an explicit `--config` path force direct mode.
 */
async function registry(): Promise<Registry> {
  const g = program.opts<GlobalOpts>();
  const { config } = loadConfig({ explicitPath: g.config });
  loaded = config;

  const useDaemon = g.daemon !== false && !process.env.DCOMPOSE_NO_DAEMON && !g.config;
  if (useDaemon) {
    const root = findProjectRoot();
    daemonClient = await DaemonClient.forProject(root);
    if (!daemonClient && config.daemon.autoStart)
      daemonClient = await ensureDaemon(root, (s) => process.stderr.write(s + "\n"));
    if (daemonClient) {
      // Config edited since the daemon started? Ask it to reload so we never run against stale servers.
      const want = configHash({ config, sources: [] });
      const have = (await daemonClient.status().catch(() => null))?.configHash;
      if (have && have !== want) {
        await daemonClient.request("reload").catch(() => {});
        if (g.verbose) process.stderr.write("[dcompose] daemon reloaded config\n");
      }
      if (g.verbose) process.stderr.write("[dcompose] using daemon\n");
    }
  }
  return new Registry(config, { verbose: g.verbose, remote: daemonClient });
}

async function run(fn: (r: Registry) => Promise<number>): Promise<void> {
  let r: Registry | null = null;
  let code: number;
  try {
    r = await registry();
    code = await fn(r);
  } catch (e) {
    code = classify(e);
    process.stderr.write(`dcompose: ${(e as Error).message}\n`);
    if (program.opts<GlobalOpts>().verbose && (e as Error).stack) process.stderr.write((e as Error).stack + "\n");
  } finally {
    // Stdio children keep the event loop alive; close them and exit explicitly.
    await r?.closeAll();
    daemonClient?.close();
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
  .option("--force", "overwrite existing imported entries and SKILL.md")
  .option("--no-skill", "do not write .claude/skills/dcompose/SKILL.md")
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
  .option("--read-only", "refuse the call unless the tool is annotated readOnlyHint (exit 2)")
  .option("--jsonl", "if the result is an array, one JSON line per element")
  .option("-r, --raw-output", "print bare strings without JSON quotes")
  .option("-c, --compact", "single-line JSON even on a TTY")
  .option("--pretty", "indented JSON even when piped")
  .option("--timeout <ms>", "per-call timeout in milliseconds", int)
  .option(
    "--each",
    "read NDJSON arg objects from stdin, one call per line, NDJSON results out (inline JSON = defaults)",
  )
  .option("--concurrency <n>", "parallel calls for --each (default 5)", int)
  .action((qualified, args, opts) => run((r) => callCommand(r, qualified, args, opts)));

// The parent carries no options of its own: `list` is the default subcommand, so `runs --json` and
// `runs show --json` never compete for the same flag.
const runs = program.command("runs").description("inspect past runs");
runs
  .command("list", { isDefault: true })
  .description("list past runs, newest first")
  .option("--label <name>", "only runs with this label")
  .option("-n, --limit <n>", "how many to show (default 20)", int)
  .option("--json", "machine-readable output")
  .action(async (opts) => process.exit(await runsListCommand(opts)));
runs
  .command("show [id-prefix]")
  .description("per-call trace of one run (default: most recent)")
  .option("--label <name>", "most recent run with this label")
  .option("--json", "whole run as one JSON object")
  .option("--jsonl", "one JSON line per call")
  .action(async (prefix, opts) => process.exit(await runsShowCommand(prefix, opts)));

const daemon = program.command("daemon").description("keep MCP connections warm across runs (one daemon per project)");
daemon
  .command("start")
  .description("start a detached daemon for this project (no-op if running)")
  .option("--idle <dur>", "exit after this long without requests (default from config, 1h; 0 = never)")
  .option("--foreground", "run in this terminal instead of detaching")
  .option("-v, --verbose", "forward MCP server stderr into the daemon log")
  .action(async (opts) => process.exit(await daemonStart(opts)));
daemon
  .command("stop")
  .description("ask the daemon to shut down")
  .action(async () => process.exit(await daemonStop()));
daemon
  .command("status")
  .description("pid, uptime, and which servers are warm")
  .option("--json", "machine-readable output")
  .action(async (opts) => process.exit(await daemonStatus(opts)));
daemon
  .command("log")
  .description("tail the daemon log")
  .option("-n, --lines <n>", "lines to show", int, 40)
  .action(async (opts) => process.exit(await daemonLog(opts.lines)));
daemon
  .command("run", { hidden: true })
  .requiredOption("--project <root>")
  .option("--idle <dur>")
  .option("-v, --verbose")
  .action(async (opts) => process.exit(await daemonRun(opts.project, opts)));

program
  .command("types")
  .description("generate .dcompose/types/mcp.d.ts so ctx.mcp is strictly typed")
  .option("-s, --server <names...>", "only these servers")
  .option("--force", "regenerate even if tool schemas are unchanged")
  .option("--out <path>", "write somewhere else")
  .option("--print", "print to stdout instead of writing")
  .action((opts) => run((r) => typesCommand(r, opts)));

program
  .command("check [scripts...]")
  .description("type-check scripts in .dcompose/scripts against the generated types")
  .option("--json", "diagnostics as JSON on stdout")
  .action(async (scripts, opts) => {
    try {
      process.exit(await checkCommand(scripts, opts));
    } catch (e) {
      process.stderr.write(`dcompose: ${(e as Error).message}\n`);
      process.exit(EXIT.CONFIG);
    }
  });

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
    .option("--allow-exec", "let the script run shell commands via ctx.sh()")
    .option("--state <name>", "store name under .dcompose/state/ (default: script name)")
    .option("-q, --quiet", "suppress the run summary on stderr")
    .option("--jsonl", "if the result is an array, one JSON line per element")
    .option("-r, --raw-output", "print bare strings without JSON quotes")
    .option("-c, --compact", "single-line JSON even on a TTY")
    .option("--pretty", "indented JSON even when piped");

runFlags(
  program
    .command("run <script>")
    .description(
      "run a script module: export default async (ctx) => value. Bare names resolve under .dcompose/scripts/",
    ),
).action((script, opts) => run((r) => runCommand(r, loaded!, { script }, opts)));

runFlags(
  program.command("eval <code>").description("run an inline expression or async body with the same context as run"),
).action((code, opts) => run((r) => runCommand(r, loaded!, { code }, opts)));

program.parseAsync(process.argv).catch((e) => {
  process.stderr.write(`dcompose: ${(e as Error).message}\n`);
  process.exit(EXIT.CONFIG);
});
