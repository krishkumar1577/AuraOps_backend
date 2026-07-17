import { allSettledPool, firstNonNull, mapPool } from '../parallel';

describe('parallel utilities', () => {
  describe('mapPool', () => {
    it('runs with bounded concurrency and preserves order', async () => {
      let active = 0;
      let maxActive = 0;
      const items = [1, 2, 3, 4, 5, 6];

      const results = await mapPool(items, 2, async (n) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise<void>((r) => {
          const t = setTimeout(r, 20);
          if (typeof t === 'object' && t && 'unref' in t) {
            (t as NodeJS.Timeout).unref();
          }
        });
        active -= 1;
        return n * 10;
      });

      expect(results).toEqual([10, 20, 30, 40, 50, 60]);
      expect(maxActive).toBeLessThanOrEqual(2);
      expect(maxActive).toBeGreaterThanOrEqual(1);
    });

    it('handles empty input', async () => {
      await expect(mapPool([], 4, async (x) => x)).resolves.toEqual([]);
    });
  });

  describe('allSettledPool', () => {
    it('captures rejections without failing the pool', async () => {
      const results = await allSettledPool([1, 2, 3], 2, async (n) => {
        if (n === 2) {
          throw new Error('boom');
        }
        return n;
      });

      expect(results[0]).toEqual({ status: 'fulfilled', value: 1 });
      expect(results[1].status).toBe('rejected');
      expect(results[2]).toEqual({ status: 'fulfilled', value: 3 });
    });
  });

  describe('firstNonNull', () => {
    it('returns first non-null result', async () => {
      const value = await firstNonNull([
        async () => {
          await new Promise<void>((r) => setTimeout(r, 30));
          return 'slow';
        },
        async () => {
          await new Promise<void>((r) => setTimeout(r, 5));
          return 'fast';
        },
        async () => null,
      ]);
      expect(value).toBe('fast');
    });

    it('returns null when all null', async () => {
      await expect(
        firstNonNull([async () => null, async () => null]),
      ).resolves.toBeNull();
    });
  });
});
