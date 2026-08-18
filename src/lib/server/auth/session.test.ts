import { describe, expect, it, vi } from 'vitest';
import { SignJWT, decodeJwt } from 'jose';

vi.mock('$env/dynamic/private', () => ({
  env: { ALGORIA_JWT_SECRET: 'test-only-session-secret-000000000000000000' }
}));
vi.mock('$app/environment', () => ({ dev: false }));

import { createAccessToken, verifyAccessToken } from './session';

const auth = {
  userId: '00000000-0000-4000-8000-000000000001',
  walletAddress: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
  sessionId: '00000000-0000-4000-8000-000000000002'
};

describe('Algoria access tokens', () => {
  it('round-trips the authenticated context', async () => {
    const context = await verifyAccessToken(await createAccessToken(auth));
    expect(context).toEqual(auth);
  });

  // The token used to be shaped like Supabase's own (`role: 'authenticated'`,
  // `aud: 'authenticated'`). Where the signing secret was set to the project's
  // JWT secret, which the setup documentation once instructed, PostgREST
  // accepted this cookie verbatim, and a user could write rows directly that the
  // server would have refused. The shape is the defence, so it is asserted here
  // rather than left to the documentation.
  it('is not shaped like a Supabase auth token', async () => {
    const claims = decodeJwt(await createAccessToken(auth));
    expect(claims.aud).toBe('algoria-session');
    expect(claims.aud).not.toBe('authenticated');
    expect(claims.role).toBeUndefined();
    expect(claims.iss).toBe('algoria');
  });

  // A validly signed token is still refused when its audience is the Supabase
  // one, so the two token populations stay disjoint even under a shared secret.
  it('refuses a validly signed token carrying the Supabase audience', async () => {
    const supabaseShaped = await new SignJWT({ role: 'authenticated', wallet_address: auth.walletAddress })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setIssuer('algoria')
      .setAudience('authenticated')
      .setSubject(auth.userId)
      .setIssuedAt()
      .setExpirationTime('15m')
      .sign(new TextEncoder().encode('test-only-session-secret-000000000000000000'));

    await expect(verifyAccessToken(supabaseShaped)).rejects.toThrow();
  });
});
