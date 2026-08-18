import { describe, expect, it, vi } from 'vitest';
import type { CatalogResource } from '$lib/types/catalog';

vi.mock('$env/dynamic/private', () => ({
  env: { ALGORIA_JWT_SECRET: 'test-only-preparation-secret-0000000000000000' }
}));

import { assertPreparedResource, signPreparedExecution, verifyPreparedExecution } from './preparation';

const resource: CatalogResource = {
  key: 'stellar8004:42:0',
  source: 'stellar8004',
  agent8004Id: 42,
  name: 'Example agent',
  description: 'Test resource',
  endpoint: 'https://agent.example/task',
  protocols: ['http', 'x402'],
  evidence: { identity: 'on-chain-8004', reputationStatus: 'unavailable', labels: [] },
  executionStatus: 'ready',
  rawSourceIds: ['stellar8004:42']
};

describe('single-use execution preparation', () => {
  it('binds a signed preparation to user, prompt, resource, and exact action', async () => {
    const action = {
      kind: 'http' as const,
      snapshot: {
        method: 'POST' as const,
        url: resource.endpoint,
        correlationId: 'c0ffee00-0000-4000-8000-000000000001',
        recoveryToken: 'A'.repeat(43),
        body: { text: 'Stellar payments' }
      },
      arguments: { text: 'Stellar payments' }
    };
    const signed = await signPreparedExecution('user-1', 'summarize Stellar payments', resource, 'x402', action);
    const prepared = await verifyPreparedExecution(signed.token, 'user-1', 'summarize Stellar payments');
    expect(prepared.action).toEqual(action);
    expect(() => assertPreparedResource(prepared, resource)).not.toThrow();
    await expect(verifyPreparedExecution(signed.token, 'user-2', 'summarize Stellar payments')).rejects.toThrow();
    await expect(verifyPreparedExecution(signed.token, 'user-1', 'changed prompt')).rejects.toThrow(/prompt changed/);
  });

  it('detects a resource endpoint change after review', async () => {
    const signed = await signPreparedExecution('user-1', 'summarize', resource, 'x402', {
      kind: 'http',
      snapshot: {
        method: 'POST',
        url: resource.endpoint,
        correlationId: 'c0ffee00-0000-4000-8000-000000000002',
        recoveryToken: 'B'.repeat(43),
        body: { text: 'payments' }
      },
      arguments: { text: 'payments' }
    });
    expect(() => assertPreparedResource(signed.prepared, { ...resource, endpoint: 'https://other.example/task' }))
      .toThrow(/changed after request review/);
  });
});
