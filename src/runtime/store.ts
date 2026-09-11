import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface Store {
  get<T = unknown>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
  all(): Promise<Record<string, unknown>>;
  clear(): Promise<void>;
  /** Where this store lives on disk. */
  readonly path: string;
}

/**
 * Tiny JSON key-value store persisted at `.dcompose/state/<name>.json`, so a monitor can
 * remember what it has already seen across relaunches. Writes are atomic (tmp + rename) and
 * synchronous, so a script killed mid-loop leaves a consistent file.
 */
export function openStore(stateDir: string, name: string): Store {
  const path = join(stateDir, `${safe(name)}.json`);
  let data: Record<string, unknown> | null = null;

  const load = (): Record<string, unknown> => {
    if (data) return data;
    if (existsSync(path)) {
      try {
        data = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
      } catch (e) {
        throw new Error(`store ${path} is corrupt: ${(e as Error).message}`);
      }
    } else {
      data = {};
    }
    return data;
  };

  const flush = (): void => {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(data ?? {}, null, 2) + "\n", "utf8");
    renameSync(tmp, path);
  };

  return {
    path,
    async get<T>(key: string) {
      return load()[key] as T | undefined;
    },
    async set(key, value) {
      load()[key] = value;
      flush();
    },
    async delete(key) {
      delete load()[key];
      flush();
    },
    async all() {
      return { ...load() };
    },
    async clear() {
      data = {};
      flush();
    },
  };
}

function safe(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^\.+/, "_") || "_default";
}
