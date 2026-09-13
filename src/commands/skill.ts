import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative } from "node:path";
import { EXIT } from "../output.ts";
import { skillFiles } from "../skill.ts";

export interface SkillOptions {
  user?: boolean;
  project?: boolean;
  force?: boolean;
  dir?: string;
}

/** Where Claude Code looks for skills: per user, or per project. */
export function skillDir(scope: "user" | "project", cwd = process.cwd()): string {
  return scope === "user"
    ? join(homedir(), ".claude", "skills", "dcompose")
    : join(cwd, ".claude", "skills", "dcompose");
}

/** Write SKILL.md and its companions into `dir`. Returns what was written and what was kept. */
export function writeSkillFiles(dir: string, force: boolean): { written: string[]; kept: string[] } {
  mkdirSync(dir, { recursive: true });
  const written: string[] = [];
  const kept: string[] = [];
  for (const [file, content] of Object.entries(skillFiles())) {
    const p = join(dir, file);
    if (!existsSync(p) || force) {
      writeFileSync(p, content, "utf8");
      written.push(file);
    } else {
      kept.push(file);
    }
  }
  return { written, kept };
}

/**
 * `dcompose skill --user` installs the skill for every project on this machine without touching
 * any repo; `--project` (the default, same as `init`) writes it into ./.claude/skills/.
 */
export async function skillCommand(opts: SkillOptions): Promise<number> {
  const err = (s: string) => process.stderr.write(s + "\n");
  const dir = opts.dir ?? skillDir(opts.user ? "user" : "project");
  const { written, kept } = writeSkillFiles(dir, opts.force ?? false);
  const shown = opts.user || opts.dir ? dir : relative(process.cwd(), dir) || dir;
  if (written.length) err(`wrote ${shown}/{${written.join(",")}}`);
  if (kept.length) err(`${shown}/{${kept.join(",")}} already exist, left alone (--force to overwrite)`);
  if (opts.user) err("Claude Code loads ~/.claude/skills on startup; start a new session for it to appear.");
  return EXIT.OK;
}
