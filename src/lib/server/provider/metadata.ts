import { buildMetadataJson } from '@trionlabs/stellar8004';
import { ACTIVE_NETWORK_LABEL, LEAN_V0_NETWORK } from '$lib/constants';
import { PROVIDER_PRICE_ATOMIC, PROVIDER_PRICE_USDC } from './config';
import { PROVIDER_SERVICES, PROVIDER_SERVICE_NAMES } from './services';

function normalizedOrigin(value: string): string {
  const origin = new URL(value).origin;
  if (!origin.startsWith('https://') && !origin.startsWith('http://localhost') && !origin.startsWith('http://127.0.0.1')) {
    throw new Error('Provider origin must use HTTPS outside localhost');
  }
  return origin;
}

export function providerRegistrationMetadata(originValue: string) {
  const origin = normalizedOrigin(originValue);
  return buildMetadataJson({
    name: 'Algoria Deterministic Test Provider',
    description: `Controlled ${ACTIVE_NETWORK_LABEL} provider for observable HTTP and exact x402 behavior. It does not call an external model.`,
    imageUrl: '',
    services: PROVIDER_SERVICE_NAMES.map((name) => ({
      name: `HTTP x402 ${name}`,
      endpoint: `${origin}/api/provider/${name}`,
      version: '1.0.0',
      description: PROVIDER_SERVICES[name].description,
      inputExample: JSON.stringify(PROVIDER_SERVICES[name].inputExample)
    })),
    supportedTrust: ['crypto-economic'],
    x402Enabled: true
  });
}

export function providerProtocolManifest(originValue: string, payTo: string, agentId?: number) {
  const origin = normalizedOrigin(originValue);
  return {
    version: 1,
    provider: 'algoria-controlled-test-provider',
    agent8004Id: agentId,
    network: LEAN_V0_NETWORK.caip2,
    invocationProtocol: 'http',
    paymentProtocol: 'x402',
    scheme: 'exact',
    asset: LEAN_V0_NETWORK.usdcSac,
    amountAtomic: PROVIDER_PRICE_ATOMIC,
    amountUsdc: PROVIDER_PRICE_USDC,
    payTo,
    correlationHeader: 'X-Algoria-Correlation-Id',
    recoveryHeader: 'X-Algoria-Recovery-Token',
    recoveryUrlTemplate: `${origin}/api/provider/status/{correlationId}`,
    services: PROVIDER_SERVICE_NAMES.map((name) => ({
      name,
      endpoint: `${origin}/api/provider/${name}`,
      inputSchema: PROVIDER_SERVICES[name].inputSchema,
      inputExample: PROVIDER_SERVICES[name].inputExample
    })),
    registrationMetadata: providerRegistrationMetadata(origin)
  };
}
