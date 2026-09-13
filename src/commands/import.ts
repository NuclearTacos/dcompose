import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  LOCAL_CONFIG_FILE,
  importFromClaude,
  isStdio,
  userConfigFile,
  writeConfigFile,
  type ServerConfig,
} from "../config.ts";
import { EXIT } from "../output.ts";

export interface ImportOptions {
  user?: boolean;
  project?: boolean;
  force?: boolean;
  list?: boolean;
}

const err = (s: string) => process.stderr.write(s + "\n");

/**
 * `dcompose import [names...]`: copy MCP servers from Claude Code's config into dcompose's.
 * Default target is the user-level ~/.dcompose/config.json, which is right for "I need PagerDuty
 * from inside a repo I do not own": nothing is written into the current directory. `--project`
 * writes ./dcompose.local.json instead (what `init --import-claude` does).
 */
export async function importCommand(names: string[], opts: ImportOptions): Promise<number> {
  const cwd = process.cwd();
  const { imported, skipped } = importFromClaude(cwd);

  if (opts.list) {
    for (const [name, sc] of Object.entries(imported)) err(`${name.padEnd(18)} ${describe(sc)}`);
    for (const s of skipped) err(`${s.name.padEnd(18)} skipped: ${s.reason}`);
    if (!Object.keys(imported).length) err("nothing importable found in ~/.claude.json or ./.mcp.json");
    return EXIT.OK;
  }

  const wanted = names.length ? names : Object.keys(imported);
  const missing = wanted.filter((n) => !(n in imported));
  if (missing.length) {
    err(
      `dcompose: not found in Claude Code config: ${missing.join(", ")}. Known: ${Object.keys(imported).join(", ") || "(none)"}`,
    );
    return EXIT.CONFIG;
  }

  const target = opts.project ? join(cwd, LOCAL_CONFIG_FILE) : userConfigFile();
  const existing = readServers(target);
  const merged = { ...existing };
  const added: string[] = [];
  const kept: string[] = [];
  for (const n of wanted) {
    if (n in existing && !opts.force) kept.push(n);
    else {
      merged[n] = imported[n]!;
      added.push(n);
    }
  }
  const current = target === userConfigFile() ? readWhole(target) : {};
  writeConfigFile(target, { ...current, mcpServers: merged });

  for (const n of added) err(`  imported ${n}  (${describe(imported[n]!)})`);
  for (const n of kept) err(`  kept existing ${n}  (--force to overwrite)`);
  err(`wrote ${target}`);
  if (opts.project)
    err(`${LOCAL_CONFIG_FILE} may contain secrets copied from Claude Code's env blocks; keep it out of git.`);
  else err("user-level config applies in every directory; nothing was written to the current directory.");
  return EXIT.OK;
}

function readServers(path: string): Record<string, ServerConfig> {
  if (!existsSync(path)) return {};
  try {
    return (JSON.parse(readFileSync(path, "utf8")) as { mcpServers?: Record<string, ServerConfig> }).mcpServers ?? {};
  } catch {
    return {};
  }
}

function readWhole(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function describe(sc: ServerConfig): string {
  return isStdio(sc) ? `stdio: ${sc.command} ${sc.args.join(" ")}`.trim().slice(0, 100) : `${sc.type}: ${sc.url}`;
}
