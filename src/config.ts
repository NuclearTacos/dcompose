import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { z } from "zod";
import { createHash } from "node:crypto";

// Same shape as Claude Code's `mcpServers` entries so users can copy them verbatim.
const StdioServer = z.object({
  type: z.literal("stdio").optional(),
  command: z.string(),
  args: z.array(z.string()).default([]),
  env: z.record(z.string(), z.string()).default({}),
  cwd: z.string().optional(),
});

const HttpServer = z.object({
  type: z.enum(["http", "sse"]),
  url: z.string().url(),
  headers: z.record(z.string(), z.string()).default({}),
  oauth: z.boolean().default(false),
});

export const ServerConfig = z.union([StdioServer, HttpServer]);
export type ServerConfig = z.infer<typeof ServerConfig>;
export type StdioServerConfig = z.infer<typeof StdioServer>;
export type HttpServerConfig = z.infer<typeof HttpServer>;

export const Config = z.object({
  mcpServers: z.record(z.string(), ServerConfig).default({}),
  daemon: z
    .object({
      /* Start a daemon automatically the first time a command needs a server. */
      autoStart: z.boolean().default(false),
      /* Exit after this long with no requests. 0 = never. */
      idle: z.string().default("1h"),
    })
    .prefault({}),
  defaults: z
    .object({
      maxCalls: z.number().int().nonnegative().default(200),
      timeout: z.string().default("5m"),
      concurrency: z.number().int().positive().default(5),
      connectTimeoutMs: z.number().int().positive().default(30_000),
    })
    .prefault({}),
});
export type Config = z.infer<typeof Config>;

export const CONFIG_FILE = "dcompose.json";
export const LOCAL_CONFIG_FILE = "dcompose.local.json";
/** ~/.dcompose, or $DCOMPOSE_HOME. Holds config.json, auth/, daemons/, workspaces/. Read lazily so tests can redirect it. */
export function dcomposeHome(): string {
  return process.env.DCOMPOSE_HOME || join(homedir(), ".dcompose");
}
export function userConfigFile(): string {
  return join(dcomposeHome(), "config.json");
}

export function isStdio(c: ServerConfig): c is StdioServerConfig {
  return "command" in c;
}

/** Expand `${VAR}` and `${VAR:-default}` in every string value, recursively. */
export function expandEnv<T>(value: T, env: NodeJS.ProcessEnv = process.env): T {
  if (typeof value === "string") {
    return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_m, name, def) => {
      const v = env[name];
      if (v !== undefined) return v;
      if (def !== undefined) return def;
      return "";
    }) as T;
  }
  if (Array.isArray(value)) return value.map((v) => expandEnv(v, env)) as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = expandEnv(v, env);
    return out as T;
  }
  return value;
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new ConfigError(`Failed to read ${path}: ${(e as Error).message}`);
  }
}

export class ConfigError extends Error {}

export interface LoadedConfig {
  config: Config;
  /** Files that contributed, in merge order (later wins). */
  sources: string[];
}

/**
 * Resolution order (later overrides earlier, per server name):
 *   ~/.dcompose/config.json  →  ./dcompose.json  →  ./dcompose.local.json
 * An explicit path (--config or DCOMPOSE_CONFIG) replaces the whole chain.
 */
export function loadConfig(opts: { explicitPath?: string; cwd?: string } = {}): LoadedConfig {
  const cwd = opts.cwd ?? process.cwd();
  const explicit = opts.explicitPath ?? process.env.DCOMPOSE_CONFIG;

  const candidates = explicit
    ? [resolve(cwd, explicit)]
    : [userConfigFile(), join(cwd, CONFIG_FILE), join(cwd, LOCAL_CONFIG_FILE)];

  const sources: string[] = [];
  let merged: { mcpServers: Record<string, unknown>; defaults: Record<string, unknown> } = {
    mcpServers: {},
    defaults: {},
  };

  for (const path of candidates) {
    if (!existsSync(path)) {
      if (explicit) throw new ConfigError(`Config file not found: ${path}`);
      continue;
    }
    const raw = readJson(path) as Partial<typeof merged> | null;
    if (!raw || typeof raw !== "object") throw new ConfigError(`${path} is not a JSON object`);
    merged = {
      mcpServers: { ...merged.mcpServers, ...(raw.mcpServers ?? {}) },
      defaults: { ...merged.defaults, ...(raw.defaults ?? {}) },
    };
    sources.push(path);
  }

  const parsed = Config.safeParse(expandEnv(merged));
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new ConfigError(`Invalid config (${sources.join(", ") || "no files"}):\n${issues}`);
  }
  return { config: parsed.data, sources };
}

// ---------------------------------------------------------------------------
// Import from Claude Code

export interface ImportResult {
  imported: Record<string, ServerConfig>;
  skipped: { name: string; reason: string }[];
}

/**
 * Read stdio + HTTP servers from ~/.claude.json (global and per-project) and ./.mcp.json.
 * claude.ai-hosted connectors are not in these files at all; nothing to skip there, but
 * unknown shapes are reported rather than silently dropped.
 */
export function importFromClaude(cwd = process.cwd()): ImportResult {
  const imported: Record<string, ServerConfig> = {};
  const skipped: ImportResult["skipped"] = [];

  const take = (entries: Record<string, unknown> | undefined, origin: string) => {
    for (const [name, raw] of Object.entries(entries ?? {})) {
      const r = ServerConfig.safeParse(normaliseClaudeEntry(raw));
      if (r.success) imported[name] = r.data;
      else skipped.push({ name, reason: `${origin}: unsupported entry shape (${r.error.issues[0]?.message})` });
    }
  };

  const claudeJson = join(homedir(), ".claude.json");
  if (existsSync(claudeJson)) {
    const c = readJson(claudeJson) as {
      mcpServers?: Record<string, unknown>;
      projects?: Record<string, { mcpServers?: Record<string, unknown> }>;
    };
    take(c.mcpServers, "~/.claude.json");
    const projectKey = Object.keys(c.projects ?? {}).find((k) => resolve(k) === resolve(cwd));
    if (projectKey) take(c.projects![projectKey]!.mcpServers, `~/.claude.json projects[${projectKey}]`);
  }

  const projectMcp = join(cwd, ".mcp.json");
  if (existsSync(projectMcp)) {
    const c = readJson(projectMcp) as { mcpServers?: Record<string, unknown> };
    take(c.mcpServers, ".mcp.json");
  }

  return { imported, skipped };
}

function normaliseClaudeEntry(raw: unknown): unknown {
  if (!raw || typeof raw !== "object") return raw;
  const e = { ...(raw as Record<string, unknown>) };
  // Claude Code writes "type": "stdio" | "http" | "sse"; older entries omit type for stdio.
  if (e.type === undefined && typeof e.command === "string") e.type = "stdio";
  return e;
}

export function writeConfigFile(
  path: string,
  config: { mcpServers?: Record<string, ServerConfig>; defaults?: Partial<Config["defaults"]> },
): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(config, null, 2) + "\n", "utf8");
}

/**
 * Nearest ancestor (including cwd) containing dcompose.json or dcompose.local.json.
 *
 * If none exists, dcompose is running on user-level config alone (~/.dcompose/config.json) inside
 * a directory that never opted in. Writing `.dcompose/` runs, state, or types there would litter
 * someone else's repo, so fall back to a per-directory workspace under ~/.dcompose/workspaces/.
 * `dcompose init` creates a project config and switches the directory to project mode.
 */
export function findProjectRoot(cwd = process.cwd()): string {
  let dir = resolve(cwd);
  while (true) {
    if (existsSync(join(dir, CONFIG_FILE)) || existsSync(join(dir, LOCAL_CONFIG_FILE))) return dir;
    // Already inside a dcompose root (a project's `.dcompose/` or a home workspace): running from
    // its scripts/ folder must not spawn a second, nested workspace.
    if (isDcomposeRoot(join(dir, ".dcompose"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return homeWorkspace(cwd);
    dir = parent;
  }
}

/**
 * A `.dcompose` folder marks a root only when it looks like one (has `scripts/` or `runs/`) and is
 * not dcompose's own home. The user's home directory has a `.dcompose` child too (config.json,
 * auth/, workspaces/), and treating that as a root would send every unconfigured directory's runs
 * into ~/.dcompose/runs.
 */
function isDcomposeRoot(marker: string): boolean {
  if (!existsSync(marker)) return false;
  if (samePath(marker, dcomposeHome()) || samePath(marker, join(homedir(), ".dcompose"))) return false;
  return existsSync(join(marker, "scripts")) || existsSync(join(marker, "runs"));
}

function samePath(a: string, b: string): boolean {
  return resolve(a).replace(/\\/g, "/").toLowerCase() === resolve(b).replace(/\\/g, "/").toLowerCase();
}

/** ~/.dcompose/workspaces/<short hash of cwd>; created on demand. */
export function homeWorkspace(cwd = process.cwd()): string {
  const key = createHash("sha1").update(resolve(cwd).toLowerCase().replace(/\\/g, "/")).digest("hex").slice(0, 12);
  const dir = join(dcomposeHome(), "workspaces", key);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Parse "30s", "5m", "2h", "500ms", or a bare number of milliseconds. 0 = no limit. */
export function parseDuration(s: string | number): number {
  if (typeof s === "number") return s;
  const m = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/.exec(s.trim());
  if (!m) throw new ConfigError(`invalid duration: ${s}`);
  const n = Number(m[1]);
  switch (m[2]) {
    case "ms":
      return n;
    case "s":
      return n * 1000;
    case "m":
      return n * 60_000;
    case "h":
      return n * 3_600_000;
    default:
      return n;
  }
}

/** Stable hash of the effective config, so a daemon can tell when its config is stale. */
export function configHash(loaded: LoadedConfig): string {
  return createHash("sha1").update(JSON.stringify(loaded.config)).digest("hex").slice(0, 12);
}
