import {
  HTTPFacilitatorClient,
  x402HTTPResourceServer,
  x402ResourceServer,
  type FacilitatorClient,
  type HTTPRequestContext,
  type HTTPResponseInstructions,
  type ProcessSettleFailureResponse
} from '@x402/core/server';
import { ExactStellarScheme } from '@x402/stellar/exact/server';
import { ACTIVE_NETWORK_LABEL } from '$lib/constants';
import type { ProviderConfig } from './config';
import { providerConfig } from './config';
import { PROVIDER_SERVICES, PROVIDER_SERVICE_NAMES } from './services';

export type ProviderPaymentServer = Pick<x402HTTPResourceServer, 'processHTTPRequest' | 'processSettlement'>;

export async function createProviderPaymentServer(
  config: ProviderConfig,
  facilitator: FacilitatorClient = new HTTPFacilitatorClient({ url: config.facilitatorUrl, timeoutMs: 20_000 })
): Promise<ProviderPaymentServer> {
  const resourceServer = new x402ResourceServer(facilitator)
    .register(config.network, new ExactStellarScheme());
  const routes = Object.fromEntries(PROVIDER_SERVICE_NAMES.map((service) => [
    `POST /api/provider/${service}`,
    {
      accepts: {
        scheme: 'exact',
        network: config.network,
        payTo: config.payTo,
        price: { asset: config.asset, amount: config.priceAtomic },
        maxTimeoutSeconds: 60
      },
      description: PROVIDER_SERVICES[service].description,
      serviceName: PROVIDER_SERVICES[service].title,
      mimeType: 'application/json',
      tags: ['algoria', 'deterministic', service],
      unpaidResponseBody: async () => ({
        contentType: 'application/json',
        body: { code: 'payment-required', message: `Exact ${ACTIVE_NETWORK_LABEL} USDC payment is required` }
      }),
      settlementFailedResponseBody: async (_context: HTTPRequestContext, failure: Omit<ProcessSettleFailureResponse, 'response'>) => ({
        contentType: 'application/json',
        body: {
          code: 'settlement-failed',
          errorReason: failure.errorReason,
          message: failure.errorMessage ?? failure.errorReason
        }
      })
    }
  ]));
  const httpServer = new x402HTTPResourceServer(resourceServer, routes);
  await httpServer.initialize();
  return httpServer;
}

let serverPromise: Promise<ProviderPaymentServer> | null = null;

export function getProviderPaymentServer(): Promise<ProviderPaymentServer> {
  if (!serverPromise) {
    serverPromise = createProviderPaymentServer(providerConfig()).catch((error) => {
      serverPromise = null;
      throw error;
    });
  }
  return serverPromise;
}

export function providerHttpContext(request: Request, body: unknown): HTTPRequestContext {
  const url = new URL(request.url);
  const query = Object.fromEntries(url.searchParams.entries());
  const adapter = {
    getHeader: (name: string) => request.headers.get(name) ?? undefined,
    getMethod: () => request.method,
    getPath: () => url.pathname,
    getUrl: () => url.toString(),
    getAcceptHeader: () => request.headers.get('accept') ?? '',
    getUserAgent: () => request.headers.get('user-agent') ?? '',
    getQueryParams: () => query,
    getQueryParam: (name: string) => query[name],
    getBody: () => body
  };
  return {
    adapter,
    path: url.pathname,
    method: request.method,
    paymentHeader: request.headers.get('payment-signature') ?? undefined
  };
}

export function responseFromInstructions(
  instructions: HTTPResponseInstructions,
  additionalHeaders: Record<string, string> = {}
): Response {
  const headers = new Headers(instructions.headers);
  for (const [name, value] of Object.entries(additionalHeaders)) headers.set(name, value);
  if (instructions.body === undefined) return new Response(null, { status: instructions.status, headers });
  if (typeof instructions.body === 'string') return new Response(instructions.body, { status: instructions.status, headers });
  if (!headers.has('content-type')) headers.set('content-type', 'application/json');
  return new Response(JSON.stringify(instructions.body), { status: instructions.status, headers });
}
