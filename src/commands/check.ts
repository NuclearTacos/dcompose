import { existsSync, readdirSync, statSync } from "node:fs";
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
  const parsed = tsMod.getParsedCommandLineOfConfigFile(
    tsconfigPath,
    {},
    {
      ...tsMod.sys,
      onUnRecoverableConfigFileDiagnostic: (d) => {
        throw new Error(tsMod.flattenDiagnosticMessageText(d.messageText, "\n"));
      },
    },
  );
  if (!parsed) throw new Error(`could not parse ${tsconfigPath}`);

  // A directory argument means every .ts/.js file directly inside it.
  const expanded = scripts.flatMap((s) => {
    const p = resolve(s);
    if (existsSync(p) && statSync(p).isDirectory()) {
      return readdirSync(p)
        .filter((f) => /.(ts|mts|js|mjs)$/.test(f) && !f.endsWith(".d.ts"))
        .map((f) => join(p, f));
    }
    return [s];
  });
  // `norm` lowercases so Windows paths compare correctly, but TypeScript must be handed the real
  // path: a lowercased root name does not exist on a case-sensitive filesystem, and tsc then
  // silently checks nothing and reports "ok". Keep the two apart — `targets` is what gets compiled,
  // `only` is only ever used for matching. Deduped by normalised form, keeping the on-disk casing.
  const targets = [
    ...new Map(expanded.map((s) => resolve(resolveScript(s, projectRoot))).map((p) => [norm(p), p])).values(),
  ];
  const only = targets.length ? new Set(targets.map(norm)) : null;
  const rootNames = only
    ? [
        ...parsed.fileNames.filter((f) => only.has(norm(resolve(f)))),
        ...targets.filter((f) => !parsed.fileNames.some((p) => norm(resolve(p)) === norm(f))),
      ]
    : parsed.fileNames;
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
          return {
            file: d.file?.fileName,
            line: pos ? pos.line + 1 : null,
            col: pos ? pos.character + 1 : null,
            code: d.code,
            message: tsMod.flattenDiagnosticMessageText(d.messageText, "\n"),
          };
        }),
      ) + "\n",
    );
  } else {
    const host: ts.FormatDiagnosticsHost = {
      getCanonicalFileName: (f) => f,
      getCurrentDirectory: () => process.cwd(),
      getNewLine: () => "\n",
    };
    const colour = !process.env.NO_COLOR && process.stderr.isTTY;
    if (diags.length)
      process.stderr.write(
        colour ? tsMod.formatDiagnosticsWithColorAndContext(diags, host) : tsMod.formatDiagnostics(diags, host),
      );
    // Echo what a bare name resolved to; in workspace mode that path is not guessable.
    if (only) for (const s of expanded) process.stderr.write(`checking ${resolveScript(s, projectRoot)}\n`);
    const checked = only ? only.size : rootNames.filter((f) => !f.endsWith(".d.ts")).length;
    process.stderr.write(
      `${diags.length === 0 ? "ok" : `${diags.length} error${diags.length === 1 ? "" : "s"}`} · ${checked} script${checked === 1 ? "" : "s"} checked\n`,
    );
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
