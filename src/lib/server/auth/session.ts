import { createHmac, randomBytes } from 'node:crypto';
import { dev } from '$app/environment';
import { env } from '$env/dynamic/private';
import { SignJWT, jwtVerify } from 'jose';
import type { Cookies } from '@sveltejs/kit';
import { getAdminClient } from '$lib/server/db/client';

const ACCESS_COOKIE = 'algoria_access';
const REFRESH_COOKIE = 'algoria_refresh';
const ACCESS_TTL_SECONDS = 15 * 60;
const REFRESH_TTL_SECONDS = 7 * 24 * 60 * 60;

export interface AuthContext {
  userId: string;
  walletAddress: string;
  sessionId?: string;
}

function jwtSecret(): Uint8Array {
  if (!env.ALGORIA_JWT_SECRET || env.ALGORIA_JWT_SECRET.length < 32) {
    throw new Error('ALGORIA_JWT_SECRET must contain at least 32 characters');
  }
  return new TextEncoder().encode(env.ALGORIA_JWT_SECRET);
}

function refreshHash(token: string): string {
  if (!env.ALGORIA_SESSION_PEPPER || env.ALGORIA_SESSION_PEPPER.length < 32) {
    throw new Error('ALGORIA_SESSION_PEPPER must contain at least 32 characters');
  }
  return createHmac('sha256', env.ALGORIA_SESSION_PEPPER).update(token).digest('hex');
}

function secureCookie(): boolean {
  return !dev;
}

/**
 * The audience is deliberately Algoria's own, and the token deliberately carries
 * no `role` claim. An earlier shape mirrored Supabase's (`role: 'authenticated'`,
 * `aud: 'authenticated'`), which meant that anywhere `ALGORIA_JWT_SECRET` was set
 * to the project's own JWT secret, this cookie was also a valid PostgREST
 * credential. A user could then reach the database directly and write rows the
 * server would never have accepted, bypassing the spend ceiling and the Job state
 * machine entirely. Nothing in Algoria ever read either claim; they only made the
 * token forgeable into something it should never have been. Keeping the audience
 * distinct means a shared secret is no longer sufficient to make that mistake.
 */
const ACCESS_AUDIENCE = 'algoria-session';

export async function createAccessToken(auth: AuthContext): Promise<string> {
  return new SignJWT({
    wallet_address: auth.walletAddress,
    session_id: auth.sessionId
  })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuer('algoria')
    .setAudience(ACCESS_AUDIENCE)
    .setSubject(auth.userId)
    .setIssuedAt()
    .setExpirationTime(`${ACCESS_TTL_SECONDS}s`)
    .sign(jwtSecret());
}

export async function verifyAccessToken(token: string): Promise<AuthContext> {
  const { payload } = await jwtVerify(token, jwtSecret(), {
    algorithms: ['HS256'], issuer: 'algoria', audience: ACCESS_AUDIENCE
  });
  if (!payload.sub || typeof payload.wallet_address !== 'string') throw new Error('Invalid session claims');
  return {
    userId: payload.sub,
    walletAddress: payload.wallet_address,
    sessionId: typeof payload.session_id === 'string' ? payload.session_id : undefined
  };
}

export async function createSession(cookies: Cookies, auth: Omit<AuthContext, 'sessionId'>): Promise<AuthContext> {
  const refreshToken = randomBytes(32).toString('base64url');
  const admin = getAdminClient();
  const { data, error } = await admin.from('auth_sessions').insert({
    user_id: auth.userId,
    refresh_hash: refreshHash(refreshToken),
    expires_at: new Date(Date.now() + REFRESH_TTL_SECONDS * 1000).toISOString()
  }).select('id').single();
  if (error) throw error;
  const context = { ...auth, sessionId: data.id as string };
  setSessionCookies(cookies, await createAccessToken(context), refreshToken);
  return context;
}

export async function refreshSession(cookies: Cookies): Promise<{ auth: AuthContext; accessToken: string } | null> {
  const token = cookies.get(REFRESH_COOKIE);
  if (!token) return null;
  const admin = getAdminClient();
  const { data, error } = await admin.from('auth_sessions')
    .select('id,user_id,expires_at,revoked_at,app_users!inner(stellar_address)')
    .eq('refresh_hash', refreshHash(token))
    .is('revoked_at', null)
    .gt('expires_at', new Date().toISOString())
    .maybeSingle();
  if (error) throw error;
  if (!data) {
    clearSessionCookies(cookies);
    return null;
  }
  const user = data.app_users as unknown as { stellar_address: string };
  const auth = { userId: data.user_id as string, walletAddress: user.stellar_address, sessionId: data.id as string };
  const accessToken = await createAccessToken(auth);
  const nextRefreshToken = randomBytes(32).toString('base64url');
  const { data: rotated, error: rotateError } = await admin.from('auth_sessions')
    .update({ refresh_hash: refreshHash(nextRefreshToken), last_used_at: new Date().toISOString() })
    .eq('id', data.id)
    .eq('refresh_hash', refreshHash(token))
    .is('revoked_at', null)
    .gt('expires_at', new Date().toISOString())
    .select('id')
    .maybeSingle();
  if (rotateError) throw rotateError;
  if (!rotated) {
    clearSessionCookies(cookies);
    return null;
  }
  setSessionCookies(cookies, accessToken, nextRefreshToken);
  return { auth, accessToken };
}

export async function revokeSession(cookies: Cookies): Promise<void> {
  const token = cookies.get(REFRESH_COOKIE);
  try {
    if (token) {
      await getAdminClient().from('auth_sessions')
        .update({ revoked_at: new Date().toISOString() })
        .eq('refresh_hash', refreshHash(token));
    }
  } finally {
    clearSessionCookies(cookies);
  }
}

export function readAccessCookie(cookies: Cookies): string | null {
  return cookies.get(ACCESS_COOKIE) ?? null;
}

function setAccessCookie(cookies: Cookies, token: string) {
  cookies.set(ACCESS_COOKIE, token, {
    path: '/', httpOnly: true, secure: secureCookie(), sameSite: 'lax', maxAge: ACCESS_TTL_SECONDS
  });
}

function setSessionCookies(cookies: Cookies, accessToken: string, refreshToken: string) {
  setAccessCookie(cookies, accessToken);
  cookies.set(REFRESH_COOKIE, refreshToken, {
    path: '/', httpOnly: true, secure: secureCookie(), sameSite: 'lax', maxAge: REFRESH_TTL_SECONDS
  });
}

function clearSessionCookies(cookies: Cookies) {
  cookies.delete(ACCESS_COOKIE, { path: '/' });
  cookies.delete(REFRESH_COOKIE, { path: '/' });
}
