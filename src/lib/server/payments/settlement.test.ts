import { describe, expect, it } from 'vitest';
import { interpretSettlement, isValidTransactionHash, parseHorizonBody } from './settlement';

// Captured from a real testnet settlement produced by the paid canary.
const TESTNET_USDC_ISSUER = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
const PAY_TO = 'GDTIUC3BEIO47CBY3YZOLY5GIN4DOJVYIEWJXLSTZ5NE2LR47ORNBCZJ';
const PAYER = 'GBFH5COW7K6T24HTUR6WGQG5RAY4OVNI6OILOXJHFHEXPBVULET7CIAZ';

const expected = { amountAtomic: '100000', payTo: PAY_TO };

function operations(changes: unknown[]) {
  return { _embedded: { records: [{ type: 'invoke_host_function', asset_balance_changes: changes }] } };
}

const transfer = (overrides: Record<string, unknown> = {}) => ({
  asset_type: 'credit_alphanum4',
  asset_code: 'USDC',
  asset_issuer: TESTNET_USDC_ISSUER,
  type: 'transfer',
  from: PAYER,
  to: PAY_TO,
  amount: '0.0100000',
  ...overrides
});

describe('on-chain settlement verification', () => {
  it('accepts the exact approved transfer', () => {
    const verdict = interpretSettlement({ successful: true, ledger: 4177225 }, operations([transfer()]), expected);
    expect(verdict).toEqual({ status: 'verified', ledger: 4177225 });
  });

  it('rejects a transaction that failed on the ledger', () => {
    const verdict = interpretSettlement({ successful: false }, operations([transfer()]), expected);
    expect(verdict.status).toBe('mismatch');
  });

  it('rejects a transfer to a different recipient', () => {
    const verdict = interpretSettlement(
      { successful: true, ledger: 1 },
      operations([transfer({ to: PAYER })]),
      expected
    );
    expect(verdict.status).toBe('mismatch');
  });

  it('rejects an underpayment', () => {
    const verdict = interpretSettlement(
      { successful: true, ledger: 1 },
      operations([transfer({ amount: '0.0010000' })]),
      expected
    );
    expect(verdict.status).toBe('mismatch');
  });

  it('rejects a different asset that merely calls itself USDC', () => {
    const verdict = interpretSettlement(
      { successful: true, ledger: 1 },
      operations([transfer({ asset_issuer: PAYER })]),
      expected
    );
    expect(verdict.status).toBe('mismatch');
  });

  it('rejects a transaction carrying no balance changes', () => {
    const verdict = interpretSettlement({ successful: true, ledger: 1 }, operations([]), expected);
    expect(verdict.status).toBe('mismatch');
  });

  it('finds the approved transfer among unrelated changes', () => {
    const verdict = interpretSettlement(
      { successful: true, ledger: 42 },
      operations([transfer({ to: PAYER, amount: '5.0000000' }), transfer()]),
      expected
    );
    expect(verdict).toEqual({ status: 'verified', ledger: 42 });
  });

  // Horizon answers as application/hal+json, so the shared reader hands back text.
  it('parses a Horizon body delivered as text', () => {
    const settled = { successful: true, ledger: 7 };
    expect(parseHorizonBody(JSON.stringify(settled))).toEqual(settled);
    expect(parseHorizonBody(settled)).toEqual(settled);
    expect(parseHorizonBody('<html>gateway error</html>')).toBeNull();
  });

  it('verifies a settlement whose payloads arrived as text', () => {
    const verdict = interpretSettlement(
      parseHorizonBody(JSON.stringify({ successful: true, ledger: 4180955 })),
      parseHorizonBody(JSON.stringify(operations([transfer()]))),
      expected
    );
    expect(verdict).toEqual({ status: 'verified', ledger: 4180955 });
  });

  it('only accepts well-formed transaction hashes', () => {
    expect(isValidTransactionHash('a'.repeat(64))).toBe(true);
    expect(isValidTransactionHash('not-a-hash')).toBe(false);
    expect(isValidTransactionHash('a'.repeat(63))).toBe(false);
  });
});
