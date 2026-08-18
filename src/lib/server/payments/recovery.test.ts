import { describe, expect, it } from 'vitest';
import { interpretRecoveryResult } from './recovery';

describe('provider recovery interpretation', () => {
  it('accepts a succeeded recovery only with settlement evidence', () => {
    const settled = interpretRecoveryResult({
      status: 200,
      body: { status: 'succeeded', paymentReceipt: { settlementReference: 'abc123' } }
    });
    expect(settled).toEqual({
      kind: 'succeeded',
      result: { status: 200, body: { status: 'succeeded', paymentReceipt: { settlementReference: 'abc123' } }, txHash: 'abc123' }
    });
  });

  it('downgrades a bare succeeded response to uncertain', () => {
    const bare = interpretRecoveryResult({ status: 200, body: { status: 'succeeded' } });
    expect(bare?.kind).toBe('uncertain');
    expect(bare?.result.txHash).toBeUndefined();
  });

  it('passes processing, uncertain, and failed through unchanged', () => {
    for (const status of ['processing', 'uncertain', 'failed'] as const) {
      expect(interpretRecoveryResult({ status: 202, body: { status } })?.kind).toBe(status);
    }
  });

  it('rejects unknown statuses and malformed bodies', () => {
    expect(interpretRecoveryResult({ status: 200, body: { status: 'done' } })).toBeNull();
    expect(interpretRecoveryResult({ status: 404, body: 'not json' })).toBeNull();
    expect(interpretRecoveryResult({ status: 200, body: null })).toBeNull();
  });

  it('ignores a non-string settlement reference', () => {
    const spoofed = interpretRecoveryResult({
      status: 200,
      body: { status: 'succeeded', paymentReceipt: { settlementReference: 42 } }
    });
    expect(spoofed?.kind).toBe('uncertain');
  });
});
