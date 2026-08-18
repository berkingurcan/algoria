import { randomBytes, randomUUID } from 'node:crypto';
import type { CatalogResource } from '$lib/types/catalog';
import { safeExternalFetch, readBoundedResponse } from '$lib/server/security/egress';

export interface RequestSnapshot {
  method: 'GET' | 'POST';
  url: string;
  correlationId: string;
  recoveryToken: string;
  recoveryUrl?: string;
  body?: Record<string, unknown>;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function controlledProviderRecoveryUrl(endpoint: string, correlationId: string): string | undefined {
  const url = new URL(endpoint);
  if (!/^\/api\/provider\/(summarize|extract|classify)$/.test(url.pathname) || url.search || url.hash) return undefined;
  return new URL(`/api/provider/status/${correlationId}`, url.origin).toString();
}

export function buildRequestSnapshot(
  resource: CatalogResource,
  args: Record<string, unknown>,
  correlationId = randomUUID(),
  recoveryToken = randomBytes(32).toString('base64url')
): RequestSnapshot {
  const type = args.type;
  if (type === 'http') {
    const method = args.method === 'GET' ? 'GET' : 'POST';
    const url = new URL(resource.endpoint);
    const queryParams = record(args.queryParams);
    for (const [key, value] of Object.entries(queryParams)) {
      if (['string', 'number', 'boolean'].includes(typeof value)) url.searchParams.set(key, String(value));
    }
    return {
      method,
      url: url.toString(),
      correlationId,
      recoveryToken,
      recoveryUrl: controlledProviderRecoveryUrl(url.toString(), correlationId),
      body: method === 'POST' ? record(args.body) : undefined
    };
  }
  const input = record(args.input);
  if (input.type === 'http') return buildRequestSnapshot(resource, input, correlationId, recoveryToken);
  return { method: 'POST', url: resource.endpoint, correlationId, recoveryToken, body: args };
}

export async function sendSnapshot(snapshot: RequestSnapshot, payment?: { name: 'PAYMENT-SIGNATURE' | 'Authorization'; value: string }) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(snapshot.correlationId)) {
    throw new Error('The reviewed request has no valid correlation id');
  }
  if (!/^[A-Za-z0-9_-]{43}$/.test(snapshot.recoveryToken)) {
    throw new Error('The reviewed request has no valid recovery token');
  }
  const headers: Record<string, string> = {
    Accept: 'application/json, text/plain;q=0.9',
    'X-Algoria-Correlation-Id': snapshot.correlationId,
    'X-Algoria-Recovery-Token': snapshot.recoveryToken
  };
  if (snapshot.body) headers['Content-Type'] = 'application/json';
  if (payment) headers[payment.name] = payment.value;
  const { response, finalUrl } = await safeExternalFetch(snapshot.url, {
    method: snapshot.method,
    headers,
    body: snapshot.body ? JSON.stringify(snapshot.body) : undefined,
    signal: AbortSignal.timeout(payment ? 60_000 : 15_000)
  });
  return { response, finalUrl };
}

export async function recoverSnapshot(snapshot: RequestSnapshot) {
  if (!snapshot.recoveryUrl) return null;
  const requestUrl = new URL(snapshot.url);
  const recoveryUrl = new URL(snapshot.recoveryUrl);
  const expectedPath = `/api/provider/status/${snapshot.correlationId}`;
  if (recoveryUrl.origin !== requestUrl.origin || recoveryUrl.pathname !== expectedPath || recoveryUrl.search || recoveryUrl.hash) {
    throw new Error('The reviewed request has no valid same-origin recovery URL');
  }
  if (!/^[A-Za-z0-9_-]{43}$/.test(snapshot.recoveryToken)) {
    throw new Error('The reviewed request has no valid recovery token');
  }
  return safeExternalFetch(recoveryUrl.toString(), {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      'X-Algoria-Recovery-Token': snapshot.recoveryToken
    },
    signal: AbortSignal.timeout(15_000)
  });
}

export async function responseResult(response: Response) {
  return { status: response.status, body: await readBoundedResponse(response) };
}
