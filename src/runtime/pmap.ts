export interface PmapOptions {
  concurrency?: number;
  /** Stop on first rejection (default) or collect errors as `{ error }` entries. */
  settle?: boolean;
}

/** Bounded-concurrency map that preserves input order. */
export async function pmap<T, R>(
  items: Iterable<T>,
  fn: (item: T, index: number) => Promise<R> | R,
  opts: PmapOptions = {},
): Promise<R[]> {
  const list = Array.from(items);
  const limit = Math.max(1, opts.concurrency ?? 5);
  const out: R[] = new Array(list.length);
  let next = 0;
  let failed: unknown = undefined;
  let hasFailed = false;

  async function worker(): Promise<void> {
    while (true) {
      if (hasFailed) return;
      const i = next++;
      if (i >= list.length) return;
      try {
        out[i] = await fn(list[i]!, i);
      } catch (e) {
        if (opts.settle) {
          out[i] = { error: e instanceof Error ? e.message : String(e) } as unknown as R;
        } else {
          hasFailed = true;
          failed = e;
          return;
        }
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, list.length) }, worker));
  if (hasFailed) throw failed;
  return out;
}
