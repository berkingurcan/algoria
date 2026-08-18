import { describe, expect, it } from 'vitest';
import { DataUriStorage } from '@trionlabs/stellar8004/storage/data-uri';
import { validateAgentUri } from '@trionlabs/stellar8004';
import { LEAN_V0_NETWORK } from '$lib/constants';
import { providerProtocolManifest, providerRegistrationMetadata } from './metadata';

describe('controlled provider 8004 metadata', () => {
  it('publishes three deterministic HTTP+x402 services using the canonical SDK shape', () => {
    const metadata = providerRegistrationMetadata('https://algoria.example/path');
    expect(metadata).toMatchObject({
      type: 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1',
      name: 'Algoria Deterministic Test Provider',
      x402: true,
      supportedTrust: ['crypto-economic']
    });
    const services = metadata.services as Array<{ endpoint: string }>;
    expect(services).toHaveLength(3);
    expect(services.map((service) => service.endpoint)).toEqual([
      'https://algoria.example/api/provider/summarize',
      'https://algoria.example/api/provider/extract',
      'https://algoria.example/api/provider/classify'
    ]);
  });

  it('pins the manifest to exact Stellar testnet USDC and a bounded recovery URL', () => {
    const manifest = providerProtocolManifest(
      'https://algoria.example',
      'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
      42
    );
    expect(manifest).toMatchObject({
      agent8004Id: 42,
      network: LEAN_V0_NETWORK.caip2,
      asset: LEAN_V0_NETWORK.usdcSac,
      amountAtomic: '100000',
      amountUsdc: '0.01',
      recoveryHeader: 'X-Algoria-Recovery-Token',
      recoveryUrlTemplate: 'https://algoria.example/api/provider/status/{correlationId}'
    });
  });

  it('fits the canonical registration metadata in the 8004 data URI limit', async () => {
    const metadata = providerRegistrationMetadata('https://algoria.example');
    const agentUri = await new DataUriStorage().upload(metadata);
    expect(() => validateAgentUri(agentUri)).not.toThrow();
    expect(Buffer.byteLength(agentUri, 'utf8')).toBeLessThanOrEqual(8_192);
  });
});
