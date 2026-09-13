import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  CONFIG_FILE,
  LOCAL_CONFIG_FILE,
  dcomposeHome,
  findProjectRoot,
  loadConfig,
  userConfigFile,
} from "../config.ts";
import { emitResult, EXIT } from "../output.ts";
import { authDir } from "../auth/provider.ts";

/**
 * `dcompose where`: print every path dcompose will use from this directory. Essential when running
 * on user-level config alone, because scripts/runs/state then live in a hashed workspace under
 * ~/.dcompose that nobody can guess.
 */
export async function whereCommand(opts: { json?: boolean }): Promise<number> {
  const cwd = process.cwd();
  const root = findProjectRoot(cwd);
  const projectMode = existsSync(join(root, CONFIG_FILE)) || existsSync(join(root, LOCAL_CONFIG_FILE));
  const { sources } = loadConfig();
  const dc = join(root, ".dcompose");
  const info = {
    cwd,
    mode: projectMode ? "project" : "workspace",
    root,
    configSources: sources,
    userConfig: userConfigFile(),
    scripts: join(dc, "scripts"),
    runs: join(dc, "runs"),
    state: join(dc, "state"),
    types: join(dc, "types", "mcp.d.ts"),
    tsconfig: join(dc, "tsconfig.json"),
    daemonRecord: join(dc, "daemon.json"),
    authTokens: authDir(),
    home: dcomposeHome(),
  };
  if (opts.json) {
    emitResult(info);
    return EXIT.OK;
  }
  const lines = [
    `mode      ${info.mode}${projectMode ? "" : "  (no dcompose.json here; using a per-directory workspace so this directory is never written to)"}`,
    `root      ${info.root}`,
    `config    ${sources.length ? sources.join("\n          ") : "(none found)"}`,
    `scripts   ${info.scripts}`,
    `runs      ${info.runs}`,
    `state     ${info.state}`,
    `types     ${info.types}`,
    `auth      ${info.authTokens}`,
  ];
  process.stdout.write(lines.join("\n") + "\n");
  return EXIT.OK;
}
