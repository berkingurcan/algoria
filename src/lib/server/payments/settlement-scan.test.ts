import { describe, expect, it } from 'vitest';
import { interpretSettlement } from './settlement';

// The payer-side scan answers "was anything taken?" from the recipient's own
// payment history. These cases pin the matching rule the scan shares with
// receipt verification: same asset, same amount, same recipient, and, for the
// scan, the same payer.
const ISSUER = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
const PAY_TO = 'GDTIUC3BEIO47CBY3YZOLY5GIN4DOJVYIEWJXLSTZ5NE2LR47ORNBCZJ';
const PAYER = 'GBFH5COW7K6T24HTUR6WGQG5RAY4OVNI6OILOXJHFHEXPBVULET7CIAZ';

const transfer = (overrides: Record<string, unknown> = {}) => ({
  asset_type: 'credit_alphanum4',
  asset_code: 'USDC',
  asset_issuer: ISSUER,
  type: 'transfer',
  from: PAYER,
  to: PAY_TO,
  amount: '0.0100000',
  ...overrides
});

const operations = (changes: unknown[]) => ({
  _embedded: { records: [{ type: 'invoke_host_function', asset_balance_changes: changes }] }
});

describe('settlement matching used by the payer-side scan', () => {
  const expected = { amountAtomic: '100000', payTo: PAY_TO };

  it('accepts a transfer that matches asset, amount and recipient', () => {
    expect(interpretSettlement({ successful: true, ledger: 1 }, operations([transfer()]), expected).status)
      .toBe('verified');
  });

  it('rejects a transfer of the right amount to the wrong recipient', () => {
    expect(interpretSettlement({ successful: true, ledger: 1 }, operations([transfer({ to: PAYER })]), expected).status)
      .toBe('mismatch');
  });

  it('rejects a transfer of the wrong amount to the right recipient', () => {
    expect(interpretSettlement({ successful: true, ledger: 1 }, operations([transfer({ amount: '0.0200000' })]), expected).status)
      .toBe('mismatch');
  });

  it('rejects a look-alike asset with the same code but another issuer', () => {
    expect(interpretSettlement({ successful: true, ledger: 1 }, operations([transfer({ asset_issuer: PAYER })]), expected).status)
      .toBe('mismatch');
  });
});
