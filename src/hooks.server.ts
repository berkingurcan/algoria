import { createHash } from 'node:crypto';
import { json, type Handle } from '@sveltejs/kit';
import { env as publicEnv } from '$env/dynamic/public';
import { isDatabaseConfigured } from '$lib/server/db/client';
import { readAccessCookie, refreshSession, verifyAccessToken } from '$lib/server/auth/session';
import { apiRateLimiter, type RateLimitPolicy } from '$lib/server/security/rate-limit';
import { assertLeanV0Configuration, policyFailure } from '$lib/server/network/policy';

const RATE_LIMITS: Array<{ matches: (path: string, method: string) => boolean; scope: string; policy: RateLimitPolicy }> = [
  { matches: (path) => path === '/api/catalog/search', scope: 'catalog', policy: { limit: 30, windowMs: 60_000 } },
  { matches: (path, method) => path.startsWith('/api/auth/sep10') && method !== 'GET', scope: 'sep10-verify', policy: { limit: 10, windowMs: 60_000 } },
  { matches: (path) => path.startsWith('/api/auth/sep10'), scope: 'sep10-challenge', policy: { limit: 20, windowMs: 60_000 } },
  // Health is the one route a monitor is expected to poll, so it gets a generous
  // bucket of its own rather than the exemption it used to have. It still costs a
  // database round trip per miss, and an unthrottled route that queries is a free
  // way to burn someone else's quota.
  { matches: (path) => path === '/api/health', scope: 'health', policy: { limit: 60, windowMs: 60_000 } },
  // Routing is the only route reachable without a session that can reach a paid
  // model, and a session is cheap to obtain: SEP-10 authenticates any valid
  // keypair, funded or not. Signing out of the model call therefore bounds who
  // spends but not how fast, so this bucket is what bounds the rate. It is not a
  // spend ceiling; a per-session model budget is the control that would be, and
  // this deployment does not have one yet.
  { matches: (path) => path === '/api/router', scope: 'router', policy: { limit: 20, windowMs: 60_000 } },
  { matches: (path) => path.startsWith('/api/'), scope: 'api', policy: { limit: 120, windowMs: 60_000 } },
  // The SEP-10 toml derives a keypair per request, and nothing caches it. The root
  // page is deliberately absent: its registry crawl is already bounded by a shared
  // 300s cache with singleflight, and a limit there would be shared by everyone
  // behind one NAT and would answer a browser navigation with a JSON error body.
  { matches: (path) => path === '/.well-known/stellar.toml', scope: 'well-known', policy: { limit: 60, windowMs: 60_000 } }
];

function clientKey(event: Parameters<Handle>[0]['event']) {
  let address = 'unknown';
  try {
    address = event.getClientAddress();
  } catch {
    // A shared fallback still protects the process when an adapter cannot supply an address.
  }
  return createHash('sha256').update(address).digest('base64url').slice(0, 22);
}

function rateLimitResponse(event: Parameters<Handle>[0]['event']): Response | null {
  const selected = RATE_LIMITS.find((entry) => entry.matches(event.url.pathname, event.request.method));
  if (!selected) return null;
  const result = apiRateLimiter.consume(selected.scope, clientKey(event), selected.policy);
  if (result.allowed) return null;
  return json({ message: 'Too many requests; retry shortly' }, {
    status: 429,
    headers: {
      'cache-control': 'no-store',
      'retry-after': String(result.retryAfterSeconds),
      'x-ratelimit-limit': String(result.limit),
      'x-ratelimit-remaining': '0',
      'x-ratelimit-reset': String(Math.ceil(result.resetAt / 1_000))
    }
  });
}

function secureResponse(event: Parameters<Handle>[0]['event'], response: Response) {
  response.headers.set('x-content-type-options', 'nosniff');
  response.headers.set('x-frame-options', 'DENY');
  response.headers.set('referrer-policy', 'strict-origin-when-cross-origin');
  response.headers.set('permissions-policy', 'camera=(), microphone=(), geolocation=()');
  if (event.url.pathname.startsWith('/api/') && !response.headers.has('cache-control')) {
    response.headers.set('cache-control', 'no-store');
  }
  if ((publicEnv.PUBLIC_APP_ORIGIN || '').startsWith('https://')) {
    response.headers.set('strict-transport-security', 'max-age=31536000');
  }
  return response;
}

export const handle: Handle = async ({ event, resolve }) => {
  if (event.url.pathname.startsWith('/api/') && event.url.pathname !== '/api/health') {
    try {
      assertLeanV0Configuration();
    } catch (error) {
      const failure = policyFailure(error);
      if (failure) return secureResponse(event, json(failure.body, { status: failure.status }));
      throw error;
    }
  }
  const limited = rateLimitResponse(event);
  if (limited) return secureResponse(event, limited);
  event.locals.auth = null;
  event.locals.accessToken = null;
  const accessToken = readAccessCookie(event.cookies);
  if (accessToken) {
    try {
      event.locals.auth = await verifyAccessToken(accessToken);
      event.locals.accessToken = accessToken;
    } catch {
      // Try the refresh cookie below.
    }
  }
  if (!event.locals.auth && isDatabaseConfigured()) {
    try {
      const refreshed = await refreshSession(event.cookies);
      if (refreshed) {
        event.locals.auth = refreshed.auth;
        event.locals.accessToken = refreshed.accessToken;
      }
    } catch {
      // Missing or revoked refresh sessions are treated as anonymous.
    }
  }
  const response = await resolve(event);
  return secureResponse(event, response);
};
