import { timingSafeEqual } from 'node:crypto';
import { env } from '$env/dynamic/private';
import { StrKey } from '@stellar/stellar-sdk';
import { LEAN_V0_NETWORK } from '$lib/constants';
import { assertLeanV0Configuration } from '$lib/server/network/policy';

export const PROVIDER_PRICE_ATOMIC = '100000';
export const PROVIDER_PRICE_USDC = '0.01';
// The default facilitator settles the test network only. A pubnet deployment needs a
// pubnet-capable facilitator (for example OpenZeppelin Channels), so the URL is
// configurable and must be HTTPS.
export const PROVIDER_FACILITATOR_URL = 'https://x402.org/facilitator';

function facilitatorUrl(raw = env.ALGORIA_FACILITATOR_URL): string {
  if (!raw?.trim()) return PROVIDER_FACILITATOR_URL;
  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    throw new Error('ALGORIA_FACILITATOR_URL must be an absolute HTTPS URL');
  }
  if (parsed.protocol !== 'https:') throw new Error('ALGORIA_FACILITATOR_URL must use HTTPS');
  return parsed.toString().replace(/\/$/, '');
}

export type ProviderConfig = {
  payTo: string;
  facilitatorUrl: string;
  network: typeof LEAN_V0_NETWORK.caip2;
  asset: typeof LEAN_V0_NETWORK.usdcSac;
  priceAtomic: typeof PROVIDER_PRICE_ATOMIC;
};

export function providerConfig(payTo = env.ALGORIA_PROVIDER_PAY_TO): ProviderConfig {
  assertLeanV0Configuration();
  if (!payTo || !StrKey.isValidEd25519PublicKey(payTo)) {
    throw new Error('ALGORIA_PROVIDER_PAY_TO must be a valid Stellar G-address');
  }
  return {
    payTo,
    facilitatorUrl: facilitatorUrl(),
    network: LEAN_V0_NETWORK.caip2,
    asset: LEAN_V0_NETWORK.usdcSac,
    priceAtomic: PROVIDER_PRICE_ATOMIC
  };
}

function equalSecret(actual: string, expected: string): boolean {
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function providerTestMode(request: Request): 'response-loss' | null {
  const expected = env.ALGORIA_PROVIDER_TEST_TOKEN;
  const actual = request.headers.get('x-algoria-test-token') ?? '';
  if (!expected || !actual || !equalSecret(actual, expected)) return null;
  return request.headers.get('x-algoria-test-mode') === 'response-loss' ? 'response-loss' : null;
}
