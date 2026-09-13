import { existsSync, mkdirSync, readFileSync } from "node:fs";
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
    err(`wrote ${LOCAL_CONFIG_FILE} (gitignored; may contain secrets)`);
    err("note: claude.ai-hosted connectors are not importable; their credentials live on Anthropic's servers.");
  }

  return EXIT.OK;
}

function describe(sc: ServerConfig): string {
  return isStdio(sc) ? `stdio: ${sc.command} ${sc.args.join(" ")}`.trim() : `${sc.type}: ${sc.url}`;
}
