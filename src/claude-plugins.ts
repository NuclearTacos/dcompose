import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { expandEnv, normaliseClaudeEntry, ServerConfig } from "./config.ts";

/**
 * MCP servers that Claude Code's enabled plugins provide, read fresh on every run.
 *
 * `import` can't copy these: a plugin's `.mcp.json` launches `${CLAUDE_PLUGIN_ROOT}/...`, and that
 * root is a versioned folder under plugins/cache that moves on every plugin update. Resolving it at
 * load time instead means a plugin server works through dcompose on any machine that has the plugin,
 * launched exactly as Claude Code launches it, with nothing to import or keep current.
 */
export interface PluginServers {
  servers: Record<string, ServerConfig>;
  /** Server name → the plugin that provides it (`name@marketplace`). */
  origin: Record<string, string>;
  /** Servers that couldn't be used, and why. Never fatal: a broken plugin mustn't break dcompose. */
  skipped: { name: string; plugin: string; reason: string }[];
}

/** Claude Code's config folder: $CLAUDE_CONFIG_DIR, or ~/.claude. */
export function claudeConfigDir(): string {
  return process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
}

interface InstallRecord {
  scope?: string;
  installPath?: string;
  projectPath?: string;
}

export function discoverPluginServers(cwd = process.cwd()): PluginServers {
  const out: PluginServers = { servers: {}, origin: {}, skipped: [] };
  const dir = claudeConfigDir();
  const installed = readJsonQuiet(join(dir, "plugins", "installed_plugins.json")) as {
    plugins?: Record<string, InstallRecord | InstallRecord[]>;
  } | null;
  if (!installed?.plugins) return out;

  const enabled = enabledPlugins(dir, cwd);
  for (const key of Object.keys(installed.plugins).sort()) {
    if (enabled[key] !== true) continue;
    const record = pickInstall(installed.plugins[key]!, cwd);
    if (!record?.installPath || !existsSync(record.installPath)) continue;
    const root = record.installPath;
    const [name = key, marketplace = ""] = key.split("@");
    const vars = {
      ...process.env,
      CLAUDE_PLUGIN_ROOT: root,
      CLAUDE_PLUGIN_DATA: join(dir, "plugins", "data", marketplace ? `${name}-${marketplace}` : name),
    };
    for (const [server, raw] of Object.entries(pluginServerEntries(root))) {
      if (server in out.servers) {
        out.skipped.push({ name: server, plugin: key, reason: `name already provided by ${out.origin[server]}` });
        continue;
      }
      const r = ServerConfig.safeParse(expandEnv(normaliseClaudeEntry(raw), vars));
      if (!r.success) {
        out.skipped.push({
          name: server,
          plugin: key,
          reason: `unsupported entry shape (${r.error.issues[0]?.message})`,
        });
        continue;
      }
      out.servers[server] = r.data;
      out.origin[server] = key;
    }
  }
  return out;
}

/**
 * `enabledPlugins` from the user's settings, overridden by the project's `.claude/settings.json` and
 * then `.claude/settings.local.json`, the same order Claude Code applies them.
 */
function enabledPlugins(dir: string, cwd: string): Record<string, boolean> {
  const layers = [join(dir, "settings.json")];
  const project = findProjectClaudeDir(cwd, dir);
  if (project) layers.push(join(project, "settings.json"), join(project, "settings.local.json"));
  const out: Record<string, boolean> = {};
  for (const path of layers) {
    const s = readJsonQuiet(path) as { enabledPlugins?: Record<string, unknown> } | null;
    for (const [k, v] of Object.entries(s?.enabledPlugins ?? {})) out[k] = v === true;
  }
  return out;
}

/**
 * Nearest ancestor's `.claude/` holding a settings file. Claude Code's own config folder (and
 * ~/.claude, which is that folder unless CLAUDE_CONFIG_DIR moves it) is user settings, not a project.
 */
function findProjectClaudeDir(cwd: string, configDir: string): string | null {
  const userDirs = [configDir, join(homedir(), ".claude")];
  let d = resolve(cwd);
  while (true) {
    const candidate = join(d, ".claude");
    if (
      !userDirs.some((u) => samePath(candidate, u)) &&
      (existsSync(join(candidate, "settings.json")) || existsSync(join(candidate, "settings.local.json")))
    )
      return candidate;
    const parent = dirname(d);
    if (parent === d) return null;
    d = parent;
  }
}

/** A project- or local-scope install for this directory wins over the user-scope one. */
function pickInstall(records: InstallRecord | InstallRecord[], cwd: string): InstallRecord | undefined {
  const list = Array.isArray(records) ? records : [records];
  const here = resolve(cwd);
  const inProject = list.find(
    (r) => r.projectPath && (samePath(r.projectPath, here) || isInside(here, resolve(r.projectPath))),
  );
  return inProject ?? list.find((r) => !r.scope || r.scope === "user");
}

/** A plugin's servers: its root `.mcp.json`, plus `mcpServers` in plugin.json (inline, a path, or a list). */
function pluginServerEntries(root: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const fromFile = (path: string) => Object.assign(out, serverMap(readJsonQuiet(path)));
  fromFile(join(root, ".mcp.json"));
  const manifest = readJsonQuiet(join(root, ".claude-plugin", "plugin.json")) as { mcpServers?: unknown } | null;
  const declared = manifest?.mcpServers;
  for (const item of Array.isArray(declared) ? declared : declared ? [declared] : []) {
    if (typeof item === "string") fromFile(resolve(root, item));
    else Object.assign(out, serverMap(item));
  }
  return out;
}

/** `{ "mcpServers": { … } }`, or the bare `{ name: entry }` map some plugins use. */
function serverMap(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== "object") return {};
  const r = raw as Record<string, unknown>;
  if (r.mcpServers && typeof r.mcpServers === "object") return r.mcpServers as Record<string, unknown>;
  return Object.fromEntries(
    Object.entries(r).filter(([, v]) => v && typeof v === "object" && ("command" in v || "url" in v)),
  );
}

function readJsonQuiet(path: string): unknown {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function samePath(a: string, b: string): boolean {
  return resolve(a).replace(/\\/g, "/").toLowerCase() === resolve(b).replace(/\\/g, "/").toLowerCase();
}

function isInside(child: string, parent: string): boolean {
  const c = child.replace(/\\/g, "/").toLowerCase();
  const p = parent.replace(/\\/g, "/").toLowerCase().replace(/\/$/, "");
  return c.startsWith(p + "/");
}
