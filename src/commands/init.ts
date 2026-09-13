import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, relative } from "node:path";
import {
  CONFIG_FILE,
  LOCAL_CONFIG_FILE,
  importFromClaude,
  isStdio,
  writeConfigFile,
  type ServerConfig,
} from "../config.ts";
import { EXIT } from "../output.ts";
import { skillDir, writeSkillFiles } from "./skill.ts";

export interface InitOptions {
  importClaude?: boolean;
  force?: boolean;
  /** Commander sets this to false for --no-skill. */
  skill?: boolean;
}

export async function initCommand(cwd: string, opts: InitOptions): Promise<number> {
  const err = (s: string) => process.stderr.write(s + "\n");

  const projectPath = join(cwd, CONFIG_FILE);
  if (!existsSync(projectPath)) {
    writeConfigFile(projectPath, { mcpServers: {}, defaults: { maxCalls: 200, timeout: "5m", concurrency: 5 } });
    err(`created ${CONFIG_FILE}`);
  } else {
    err(`${CONFIG_FILE} already exists, left alone`);
  }

  for (const dir of ["scripts", "types", "runs", "state"]) mkdirSync(join(cwd, ".dcompose", dir), { recursive: true });
  err("created .dcompose/{scripts,types,runs,state}");

  if (opts.skill !== false) {
    const dir = skillDir("project", cwd);
    const { written, kept } = writeSkillFiles(dir, opts.force ?? false);
    const rel = relative(cwd, dir);
    if (written.length) err(`wrote ${rel}/{${written.join(",")}} (teaches Claude Code the dcompose workflow)`);
    if (kept.length) err(`${rel}/{${kept.join(",")}} already exist, left alone (--force to overwrite)`);
  }

  if (opts.importClaude) {
    const { imported, skipped } = importFromClaude(cwd);
    const localPath = join(cwd, LOCAL_CONFIG_FILE);

    // Imported entries may carry env secrets, so they go to the gitignored local file.
    let existing: Record<string, ServerConfig> = {};
    if (existsSync(localPath) && !opts.force) {
      existing =
        (JSON.parse(readFileSync(localPath, "utf8")) as { mcpServers?: Record<string, ServerConfig> }).mcpServers ?? {};
    }
    const merged = { ...existing };
    const added: string[] = [];
    const kept: string[] = [];
    for (const [name, sc] of Object.entries(imported)) {
      if (name in existing && !opts.force) kept.push(name);
      else {
        merged[name] = sc;
        added.push(name);
      }
    }
    writeConfigFile(localPath, { mcpServers: merged });

    for (const name of added) err(`  imported ${name}  (${describe(imported[name]!)})`);
    for (const name of kept) err(`  kept existing ${name}  (use --force to overwrite)`);
    for (const s of skipped) err(`  skipped ${s.name}: ${s.reason}`);
    if (added.length + kept.length === 0) err("  nothing found in ~/.claude.json or ./.mcp.json");

    // Imported env blocks routinely hold API keys. Say exactly what git will do with the file,
    // and make it true: add ignore rules to this repo's .gitignore when they are missing.
    const ignore = ensureGitignore(cwd, [LOCAL_CONFIG_FILE, ".dcompose/"]);
    if (ignore.kind === "not-a-repo")
      err(`wrote ${LOCAL_CONFIG_FILE} (may contain secrets; this directory is not a git repo)`);
    else if (ignore.added.length)
      err(`wrote ${LOCAL_CONFIG_FILE} (may contain secrets); added ${ignore.added.join(", ")} to .gitignore`);
    else err(`wrote ${LOCAL_CONFIG_FILE} (may contain secrets; already gitignored)`);
    if (ignore.kind === "repo")
      err(
        "tip: to use these servers from repos you do not own without adding files to them, prefer `dcompose import --user`.",
      );
    err("note: claude.ai-hosted connectors are not importable; their credentials live on Anthropic's servers.");
  }

  return EXIT.OK;
}

function describe(sc: ServerConfig): string {
  return isStdio(sc) ? `stdio: ${sc.command} ${sc.args.join(" ")}`.trim() : `${sc.type}: ${sc.url}`;
}

/**
 * Make sure `patterns` are ignored by the git repo containing `cwd`. Appends a commented block to
 * the repo root's .gitignore when any pattern is missing. Returns what was added.
 */
export function ensureGitignore(
  cwd: string,
  patterns: string[],
): { kind: "repo" | "not-a-repo"; added: string[]; path?: string } {
  const top = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8", windowsHide: true });
  if (top.status !== 0) return { kind: "not-a-repo", added: [] };
  const root = top.stdout.trim();
  const path = join(root, ".gitignore");
  const missing = patterns.filter((p) => {
    const r = spawnSync("git", ["check-ignore", "-q", p.replace(/\/$/, "/x")], {
      cwd,
      encoding: "utf8",
      windowsHide: true,
    });
    return r.status !== 0;
  });
  if (missing.length === 0) return { kind: "repo", added: [], path };
  const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
  const block = `${existing.endsWith("\n") || existing === "" ? "" : "\n"}\n# dcompose: machine-local MCP config (may hold imported secrets) and run traces\n${missing.join("\n")}\n`;
  appendFileSync(path, block, "utf8");
  return { kind: "repo", added: missing, path };
}
