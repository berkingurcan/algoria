import { describe, expect, it } from 'vitest';
import type { CatalogResource } from '$lib/types/catalog';
import { buildRequestSnapshot, controlledProviderRecoveryUrl } from './http';

const resource: CatalogResource = {
  key: 'stellar8004:42:0',
  source: 'stellar8004',
  agent8004Id: 42,
  name: 'Controlled provider',
  description: 'Test resource',
  endpoint: 'https://provider.example/api/provider/summarize',
  protocols: ['http', 'x402'],
  evidence: { identity: 'on-chain-8004', reputationStatus: 'unavailable', labels: [] },
  executionStatus: 'ready',
  rawSourceIds: ['stellar8004:42']
};

describe('immutable HTTP request snapshots', () => {
  it('binds controlled provider work to a same-origin recovery endpoint', () => {
    const correlationId = 'c0ffee00-0000-4000-8000-000000000001';
    const snapshot = buildRequestSnapshot(resource, {
      type: 'http', method: 'POST', body: { text: 'Stellar' }
    }, correlationId, 'R'.repeat(43));
    expect(snapshot.recoveryUrl).toBe(`https://provider.example/api/provider/status/${correlationId}`);
  });

  it('does not invent recovery for an unrelated agent endpoint', () => {
    expect(controlledProviderRecoveryUrl('https://provider.example/task', crypto.randomUUID())).toBeUndefined();
  });
});
