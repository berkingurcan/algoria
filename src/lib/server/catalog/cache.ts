interface Entry<T> {
  value: T;
  expiresAt: number;
}

export class CacheBusyError extends Error {
  constructor() {
    super('Catalog is temporarily busy; retry shortly');
  }
}

export class BoundedAsyncCache {
  private readonly values = new Map<string, Entry<unknown>>();
  private readonly loads = new Map<string, Promise<unknown>>();

  constructor(
    private readonly maxEntries = 200,
    private readonly maxConcurrentLoads = 16
  ) {}

  get size() {
    return this.values.size;
  }

  private pruneExpired(now: number) {
    for (const [key, entry] of this.values) {
      if (entry.expiresAt <= now) this.values.delete(key);
    }
  }

  private retainWithinLimit() {
    while (this.values.size >= this.maxEntries) {
      const oldest = this.values.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.values.delete(oldest);
    }
  }

  async get<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
    const now = Date.now();
    const hit = this.values.get(key) as Entry<T> | undefined;
    if (hit && hit.expiresAt > now) {
      this.values.delete(key);
      this.values.set(key, hit);
      return hit.value;
    }
    if (hit) this.values.delete(key);

    const pending = this.loads.get(key) as Promise<T> | undefined;
    if (pending) return pending;
    if (this.loads.size >= this.maxConcurrentLoads) throw new CacheBusyError();

    const request = load().then((value) => {
      this.pruneExpired(Date.now());
      this.retainWithinLimit();
      this.values.set(key, { value, expiresAt: Date.now() + ttlMs });
      return value;
    }).finally(() => {
      this.loads.delete(key);
    });
    this.loads.set(key, request);
    return request;
  }
}

const catalogCache = new BoundedAsyncCache();

export async function cached<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
  return catalogCache.get(key, ttlMs, load);
}
