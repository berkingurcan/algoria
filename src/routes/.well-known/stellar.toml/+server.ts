import { env } from '$env/dynamic/private';
import { env as publicEnv } from '$env/dynamic/public';
import { Keypair } from '@stellar/stellar-sdk';
import { ACTIVE_NETWORK_PASSPHRASE } from '$lib/constants';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async () => {
  const origin = publicEnv.PUBLIC_APP_ORIGIN || 'http://localhost:5173';
  const signingKey = env.SEP10_SIGNING_SECRET ? Keypair.fromSecret(env.SEP10_SIGNING_SECRET).publicKey() : '';
  const body = [
    `NETWORK_PASSPHRASE=\"${ACTIVE_NETWORK_PASSPHRASE}\"`,
    `WEB_AUTH_ENDPOINT=\"${origin}/api/auth/sep10\"`,
    `SIGNING_KEY=\"${signingKey}\"`
  ].join('\n');
  return new Response(body, { headers: { 'content-type': 'text/plain; charset=utf-8', 'access-control-allow-origin': '*' } });
};
