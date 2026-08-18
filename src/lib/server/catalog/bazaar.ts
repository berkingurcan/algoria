import { createHash } from 'node:crypto';
import { env } from '$env/dynamic/private';
import { LEAN_V0_NETWORK } from '$lib/constants';
import type { CatalogResource, JsonSchema, StellarPaymentOption } from '$lib/types/catalog';
import { atomicToUsdc, isWithinUsdcCap } from '$lib/utils/money';
import { sanitizeUntrustedText } from '$lib/server/shared/sanitize';
import { readBoundedResponse, safeExternalFetch } from '$lib/server/security/egress';
import { assertLeanV0Configuration, assertLeanV0Feature } from '$lib/server/network/policy';

type UnknownRecord = Record<string, unknown>;

function record(value: unknown): UnknownRecord {
  return typeof value === 'object' && value !== null ? (value as UnknownRecord) : {};
}

function resourceId(endpoint: string): string {
  return createHash('sha256').update(endpoint).digest('base64url').slice(0, 18);
}

function parsePayment(accepts: unknown, maxUsdc: number): { option?: StellarPaymentOption; status: CatalogResource['executionStatus'] } {
  if (!Array.isArray(accepts)) return { status: 'unsupported-payment' };
  const stellar = accepts.map(record).find((entry) => entry.network === LEAN_V0_NETWORK.caip2 && entry.asset === LEAN_V0_NETWORK.usdcSac);
  if (!stellar) return { status: 'unsupported-payment' };
  const amount = typeof stellar.amount === 'string' ? stellar.amount : '';
  const scheme = typeof stellar.scheme === 'string' ? stellar.scheme : '';
  const payTo = typeof stellar.payTo === 'string' ? stellar.payTo : '';
  if (!/^\d+$/.test(amount) || scheme !== 'exact' || !/^G[A-Z2-7]{55}$/.test(payTo)) {
    return { status: 'unsupported-payment' };
  }
  const option: StellarPaymentOption = {
    scheme,
    network: LEAN_V0_NETWORK.caip2,
    asset: LEAN_V0_NETWORK.usdcSac,
    amountAtomic: amount,
    amountUsdc: atomicToUsdc(amount),
    payTo,
    maxTimeoutSeconds: typeof stellar.maxTimeoutSeconds === 'number' ? stellar.maxTimeoutSeconds : undefined
  };
  return { option, status: isWithinUsdcCap(amount, maxUsdc) ? 'ready' : 'payment-over-cap' };
}

function mapResource(raw: UnknownRecord, maxUsdc: number): CatalogResource | null {
  const endpoint = sanitizeUntrustedText(raw.resource, 2_000);
  if (!endpoint.startsWith('https://')) return null;
  const payment = parsePayment(raw.accepts, maxUsdc);
  if (!payment.option) return null;
  const extensions = record(raw.extensions);
  const bazaar = record(extensions.bazaar);
  const schema = record(bazaar.schema);
  const quality = record(raw.quality);
  const key = resourceId(endpoint);
  return {
    key: `x402-bazaar:${key}`,
    source: 'x402-bazaar',
    name: sanitizeUntrustedText(raw.serviceName, 100) || new URL(endpoint).hostname,
    description: sanitizeUntrustedText(raw.description, 600) || 'No description supplied.',
    endpoint,
    serviceName: sanitizeUntrustedText(raw.serviceName, 100) || undefined,
    protocols: ['http', 'x402'],
    inputSchema: Object.keys(schema).length > 0 ? (schema as JsonSchema) : undefined,
    inputExample: record(bazaar.info).input,
    pricing: payment.option,
    evidence: {
      identity: 'bazaar-only',
      reputationStatus: 'not-applicable',
      qualityCalls30d: typeof quality.l30DaysTotalCalls === 'number' ? quality.l30DaysTotalCalls : undefined,
      qualityPayers30d: typeof quality.l30DaysUniquePayers === 'number' ? quality.l30DaysUniquePayers : undefined,
      labels: ['Bazaar-listed resource', 'no 8004 identity', 'schema-declared']
    },
    executionStatus: payment.status,
    updatedAt: typeof raw.lastUpdated === 'string' ? raw.lastUpdated : undefined,
    rawSourceIds: [`x402-bazaar:${key}`]
  };
}

export async function searchBazaar(query: string, limit = 20): Promise<{ resources: CatalogResource[]; partial: boolean }> {
  assertLeanV0Feature('bazaarRouting');
  const { maxPaymentUsdc } = assertLeanV0Configuration();
  const base = env.X402_BAZAAR_URL || 'https://api.cdp.coinbase.com/platform/v2/x402/discovery/search';
  const url = new URL(base);
  if (query.trim()) url.searchParams.set('query', query.trim().slice(0, 400));
  url.searchParams.set('network', LEAN_V0_NETWORK.caip2);
  url.searchParams.set('maxUsdPrice', String(maxPaymentUsdc));
  url.searchParams.set('limit', String(Math.min(Math.max(limit, 1), 20)));

  const { response } = await safeExternalFetch(url.toString(), {
    signal: AbortSignal.timeout(10_000),
    headers: { Accept: 'application/json' }
  });
  if (!response.ok) throw new Error(`Bazaar returned ${response.status}`);
  const body = record(await readBoundedResponse(response, 2_097_152));
  const maxUsdc = maxPaymentUsdc;
  const resources = Array.isArray(body.resources)
    ? body.resources.map(record).map((item) => mapResource(item, maxUsdc)).filter((item): item is CatalogResource => item !== null)
    : [];
  return { resources, partial: body.partialResults === true };
}
