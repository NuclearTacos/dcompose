import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Root of the installed dcompose package (works from src/ in dev and dist/ when built). */
export function dcomposeRoot(): string {
  // this file lives at <root>/src/paths.ts or <root>/dist/paths.js
  return dirname(dirname(fileURLToPath(import.meta.url)));
}

/** Entry the TypeScript compiler should resolve `import ... from "dcompose"` to. */
export function dcomposeTypesEntry(): string {
  const root = dcomposeRoot();
  const dist = join(root, "dist", "index.d.ts");
  return existsSync(dist) ? dist : join(root, "src", "index.ts");
}

export function projectDcomposeDir(projectRoot: string): string {
  return join(projectRoot, ".dcompose");
}
