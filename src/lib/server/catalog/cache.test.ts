import { describe, expect, it } from 'vitest';
import { BoundedAsyncCache, CacheBusyError } from './cache';

describe('bounded async cache', () => {
  it('deduplicates concurrent loads for the same key', async () => {
    const cache = new BoundedAsyncCache(5, 2);
    let loads = 0;
    let release!: (value: string) => void;
    const pending = new Promise<string>((resolve) => { release = resolve; });
    const load = () => {
      loads += 1;
      return pending;
    };
    const first = cache.get('same', 1_000, load);
    const second = cache.get('same', 1_000, load);
    release('value');
    await expect(Promise.all([first, second])).resolves.toEqual(['value', 'value']);
    expect(loads).toBe(1);
  });

  it('keeps a hard entry limit', async () => {
    const cache = new BoundedAsyncCache(2, 2);
    await cache.get('one', 1_000, async () => 1);
    await cache.get('two', 1_000, async () => 2);
    await cache.get('three', 1_000, async () => 3);
    expect(cache.size).toBe(2);
  });

  it('rejects excess unique concurrent loads', async () => {
    const cache = new BoundedAsyncCache(5, 1);
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const first = cache.get('one', 1_000, () => pending);
    await expect(cache.get('two', 1_000, async () => undefined)).rejects.toBeInstanceOf(CacheBusyError);
    release();
    await first;
  });
});
