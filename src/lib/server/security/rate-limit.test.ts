import { describe, expect, it } from 'vitest';
import { RateLimiter } from './rate-limit';

describe('rate limiter', () => {
  it('blocks requests above the fixed-window limit and resets afterwards', () => {
    const limiter = new RateLimiter();
    const policy = { limit: 2, windowMs: 1_000 };
    expect(limiter.consume('api', 'client', policy, 1_000).allowed).toBe(true);
    expect(limiter.consume('api', 'client', policy, 1_100).allowed).toBe(true);
    const blocked = limiter.consume('api', 'client', policy, 1_200);
    expect(blocked.allowed).toBe(false);
    expect(blocked.remaining).toBe(0);
    expect(limiter.consume('api', 'client', policy, 2_001).allowed).toBe(true);
  });

  it('uses a bounded shared overflow bucket when client cardinality is exhausted', () => {
    const limiter = new RateLimiter(1);
    const policy = { limit: 1, windowMs: 1_000 };
    expect(limiter.consume('api', 'known', policy, 1_000).allowed).toBe(true);
    expect(limiter.consume('api', 'overflow-a', policy, 1_000).allowed).toBe(true);
    expect(limiter.consume('api', 'overflow-b', policy, 1_000).allowed).toBe(false);
  });
});
