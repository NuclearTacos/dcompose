import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import type ts from "typescript";
import { findProjectRoot } from "../config.ts";
import { EXIT } from "../output.ts";
import { dcomposeRoot, projectDcomposeDir } from "../paths.ts";
import { resolveScript } from "../runner.ts";
import { writeTsconfig } from "./types.ts";

export interface CheckOptions {
  json?: boolean;
}

/** Type-check scripts under .dcompose/scripts (or one script) against the generated types. */
export async function checkCommand(scripts: string[], opts: CheckOptions): Promise<number> {
  const projectRoot = findProjectRoot();
  const dir = projectDcomposeDir(projectRoot);
  const tsconfigPath = join(dir, "tsconfig.json");
  if (!existsSync(tsconfigPath)) writeTsconfig(dir, projectRoot);
  if (!existsSync(join(dir, "types", "mcp.d.ts"))) {
    process.stderr.write("dcompose: no generated types yet; run `dcompose types` first (mcp will be `any`)\n");
  }

  const tsMod = loadTypescript(projectRoot);
  const parsed = tsMod.getParsedCommandLineOfConfigFile(tsconfigPath, {}, {
    ...tsMod.sys,
    onUnRecoverableConfigFileDiagnostic: (d) => {
      throw new Error(tsMod.flattenDiagnosticMessageText(d.messageText, "\n"));
    },
  });
  if (!parsed) throw new Error(`could not parse ${tsconfigPath}`);

  const only = scripts.length ? new Set(scripts.map((s) => resolve(resolveScript(s, projectRoot)).toLowerCase()).map(norm)) : null;
  const rootNames = only ? [...parsed.fileNames.filter((f) => only.has(norm(resolve(f)))), ...[...only].filter((f) => !parsed.fileNames.some((p) => norm(resolve(p)) === f))] : parsed.fileNames;
  // Always include the generated types so the module augmentation is in scope.
  const typesFile = join(dir, "types", "mcp.d.ts");
  if (existsSync(typesFile) && !rootNames.some((f) => norm(resolve(f)) === norm(typesFile))) rootNames.push(typesFile);

  const program = tsMod.createProgram(rootNames, parsed.options);
  const all = [...program.getSyntacticDiagnostics(), ...program.getSemanticDiagnostics()];
  const diags = only ? all.filter((d) => d.file && only.has(norm(resolve(d.file.fileName)))) : all;

  if (opts.json) {
    process.stdout.write(
      JSON.stringify(
        diags.map((d) => {
          const pos = d.file && d.start !== undefined ? d.file.getLineAndCharacterOfPosition(d.start) : null;
          return { file: d.file?.fileName, line: pos ? pos.line + 1 : null, col: pos ? pos.character + 1 : null, code: d.code, message: tsMod.flattenDiagnosticMessageText(d.messageText, "\n") };
        }),
      ) + "\n",
    );
  } else {
    const host: ts.FormatDiagnosticsHost = { getCanonicalFileName: (f) => f, getCurrentDirectory: () => process.cwd(), getNewLine: () => "\n" };
    if (diags.length) process.stderr.write(tsMod.formatDiagnosticsWithColorAndContext(diags, host));
    const checked = only ? only.size : rootNames.filter((f) => !f.endsWith(".d.ts")).length;
    process.stderr.write(`${diags.length === 0 ? "ok" : `${diags.length} error${diags.length === 1 ? "" : "s"}`} · ${checked} script${checked === 1 ? "" : "s"} checked\n`);
  }
  return diags.length ? EXIT.SCRIPT_ERROR : EXIT.OK;
}

function norm(p: string): string {
  return p.replace(/\\/g, "/").toLowerCase();
}

/** Prefer the project's TypeScript so versions match the user's editor; fall back to ours. */
function loadTypescript(projectRoot: string): typeof ts {
  for (const base of [join(projectRoot, "package.json"), join(dcomposeRoot(), "package.json")]) {
    try {
      return createRequire(base)("typescript") as typeof ts;
    } catch {
      /* try next */
    }
  }
  throw new Error("typescript not found; install it in the project or reinstall dcompose");
}
