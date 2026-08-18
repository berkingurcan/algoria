import { describe, expect, it } from 'vitest';
import type { CatalogResource } from '$lib/types/catalog';
import { stellarNativeExecutableResources } from './search';

function resource(overrides: Partial<CatalogResource>): CatalogResource {
  return {
    key: 'resource',
    source: 'x402-bazaar',
    name: 'Resource',
    description: 'A service',
    endpoint: 'https://example.com/api',
    protocols: ['x402'],
    evidence: { identity: 'bazaar-only', reputationStatus: 'not-applicable', labels: [] },
    executionStatus: 'ready',
    rawSourceIds: ['resource'],
    ...overrides
  };
}

describe('Stellar-native conversation routing', () => {
  it('keeps only executable resources with a Stellar 8004 identity', () => {
    const native = resource({ key: 'native', source: 'stellar8004', agent8004Id: 42, evidence: { identity: 'on-chain-8004', reputationStatus: 'declared', labels: [] } });
    const displayOnly = resource({ key: 'display', source: 'stellar8004', agent8004Id: 43, executionStatus: 'missing-schema', evidence: { identity: 'on-chain-8004', reputationStatus: 'declared', labels: [] } });
    const bazaarOnly = resource({ key: 'bazaar' });
    expect(stellarNativeExecutableResources([bazaarOnly, displayOnly, native])).toEqual([native]);
  });
});
