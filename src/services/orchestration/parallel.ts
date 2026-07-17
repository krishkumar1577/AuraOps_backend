/**
 * Bounded parallel map — runs async work with a max concurrency.
 * Used by fleet deploy, provider ranking, and multi-agent orchestration.
 */
export async function mapPool<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) {
    return [];
  }

  const limit = Math.max(1, Math.min(concurrency, items.length));
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (true) {
      const i = nextIndex;
      nextIndex += 1;
      if (i >= items.length) {
        return;
      }
      results[i] = await fn(items[i], i);
    }
  }

  await Promise.all(Array.from({ length: limit }, () => worker()));
  return results;
}

/**
 * Run async tasks with a concurrency cap; preserve input order in results.
 */
export async function allSettledPool<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  return mapPool(items, concurrency, async (item, index) => {
    try {
      const value = await fn(item, index);
      return { status: 'fulfilled' as const, value };
    } catch (reason) {
      return { status: 'rejected' as const, reason };
    }
  });
}

/**
 * Race providers / workers: first non-null success wins.
 * Losers that already resolved with a resource can be cleaned via onExtra.
 */
export async function firstNonNull<T>(
  factories: Array<() => Promise<T | null>>,
  options?: {
    /** Called for successful results that are not the winner (release GPUs, etc.). */
    onExtra?: (value: T) => Promise<void> | void;
  },
): Promise<T | null> {
  if (factories.length === 0) {
    return null;
  }

  return new Promise((resolve) => {
    let pending = factories.length;
    let settled = false;
    const extras: T[] = [];

    const finish = (winner: T | null): void => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(winner);

      if (winner && options?.onExtra && extras.length > 0) {
        void Promise.all(
          extras.map(async (extra) => {
            try {
              await options.onExtra!(extra);
            } catch {
              // best-effort release
            }
          }),
        );
      }
    };

    for (const factory of factories) {
      void factory()
        .then((value) => {
          if (settled) {
            if (value != null && options?.onExtra) {
              void Promise.resolve(options.onExtra(value)).catch(() => undefined);
            }
            return;
          }
          if (value != null) {
            // Keep any earlier non-null that arrived but lost race? first wins.
            finish(value);
            return;
          }
          pending -= 1;
          if (pending === 0) {
            finish(null);
          }
        })
        .catch(() => {
          pending -= 1;
          if (!settled && pending === 0) {
            finish(null);
          }
        });
    }
  });
}
