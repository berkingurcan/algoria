export interface RateLimitPolicy {
  limit: number;
  windowMs: number;
}

export interface RateLimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  retryAfterSeconds: number;
  resetAt: number;
}

interface Bucket {
  count: number;
  resetAt: number;
}

export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly overflow = new Map<string, Bucket>();

  constructor(private readonly maxKeys = 10_000) {}

  private consumeBucket(bucket: Bucket | undefined, policy: RateLimitPolicy, now: number) {
    if (!bucket || bucket.resetAt <= now) return { count: 1, resetAt: now + policy.windowMs };
    bucket.count += 1;
    return bucket;
  }

  private result(bucket: Bucket, policy: RateLimitPolicy, now: number): RateLimitResult {
    const allowed = bucket.count <= policy.limit;
    return {
      allowed,
      limit: policy.limit,
      remaining: Math.max(policy.limit - bucket.count, 0),
      retryAfterSeconds: Math.max(Math.ceil((bucket.resetAt - now) / 1_000), 1),
      resetAt: bucket.resetAt
    };
  }

  consume(scope: string, key: string, policy: RateLimitPolicy, now = Date.now()): RateLimitResult {
    const bucketKey = `${scope}:${key}`;
    const existing = this.buckets.get(bucketKey);
    if (existing) {
      const bucket = this.consumeBucket(existing, policy, now);
      this.buckets.delete(bucketKey);
      this.buckets.set(bucketKey, bucket);
      return this.result(bucket, policy, now);
    }

    if (this.buckets.size >= this.maxKeys) {
      for (const [candidate, bucket] of this.buckets) {
        if (bucket.resetAt <= now) this.buckets.delete(candidate);
      }
    }

    if (this.buckets.size >= this.maxKeys) {
      const bucket = this.consumeBucket(this.overflow.get(scope), policy, now);
      this.overflow.set(scope, bucket);
      return this.result(bucket, policy, now);
    }

    const bucket = this.consumeBucket(undefined, policy, now);
    this.buckets.set(bucketKey, bucket);
    return this.result(bucket, policy, now);
  }
}

export const apiRateLimiter = new RateLimiter();
