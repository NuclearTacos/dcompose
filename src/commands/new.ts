import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { findProjectRoot } from "../config.ts";
import { EXIT } from "../output.ts";

export interface NewOptions {
  force?: boolean;
  stream?: boolean;
}

/**
 * `dcompose new <name>`: write the default-export skeleton at this directory's scripts path and
 * print the path. Removes the two things a first-time user gets wrong: the module shape, and
 * where scripts live when running on user-level config (a workspace dir under ~/.dcompose).
 */
export async function newCommand(name: string, opts: NewOptions): Promise<number> {
  const safe = name.replace(/\.(ts|js|mjs)$/, "");
  if (!/^[A-Za-z0-9._-]+$/.test(safe)) {
    process.stderr.write(
      `dcompose: script names may contain letters, digits, ., _ and - only (got ${JSON.stringify(name)})\n`,
    );
    return EXIT.CONFIG;
  }
  const dir = join(findProjectRoot(), ".dcompose", "scripts");
  const path = join(dir, `${safe}.ts`);
  if (existsSync(path) && !opts.force) {
    process.stderr.write(`dcompose: ${path} exists (--force to overwrite)\n`);
    return EXIT.CONFIG;
  }
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, opts.stream ? streamSkeleton(safe) : skeleton(safe), "utf8");
  process.stderr.write(
    `wrote ${path}\nnext: edit it, then \`dcompose check ${safe}\` and \`dcompose run ${safe} --read-only\`\n`,
  );
  // The path on stdout so `$(dcompose new x)` works in a shell.
  process.stdout.write(path + "\n");
  return EXIT.OK;
}

function skeleton(name: string): string {
  return `// ${name}: describe what this returns and why it is a script (fan-out, join, paging, monitor...).
import type { Ctx } from "dcompose";

type Input = { limit?: number };

export default async function ({ mcp, pmap, paginate, unwrap, input, log }: Ctx<Input>) {
  // 1. Fetch. Replace server/tool with names from \`dcompose tools <server>\`.
  //    const { response } = await mcp.someServer.list_things({ limit: input.limit ?? 100 });
  // 2. Work in code: filter, join, aggregate, pmap(items, fn, { concurrency: 5 }).
  // 3. Return only what answers the question; everything returned enters the agent's context.
  log(\`input: \${JSON.stringify(input)}\`);
  return { todo: true };
}
`;
}

function streamSkeleton(name: string): string {
  return `// ${name}: streaming script. Each \`yield\` is one NDJSON line on stdout immediately.
import type { Ctx } from "dcompose";

type Input = { intervalMs?: number };

export default async function* ({ mcp, store, sleep, emit, input }: Ctx<Input>) {
  const seen: Record<string, string> = (await store.get("seen")) ?? {};
  while (true) {
    // const { response } = await mcp.someServer.list_things({});
    // for (const item of response) { if (seen[item.id] !== item.status) { seen[item.id] = item.status; yield item; } }
    await store.set("seen", seen);
    emit({ kind: "poll", at: new Date().toISOString() });
    await sleep(input.intervalMs ?? 30_000);
  }
}
`;
}
