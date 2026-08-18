import { describe, expect, it, vi } from 'vitest';

const PAY_TO = 'GDTIUC3BEIO47CBY3YZOLY5GIN4DOJVYIEWJXLSTZ5NE2LR47ORNBCZJ';
const PAYER = 'GBFH5COW7K6T24HTUR6WGQG5RAY4OVNI6OILOXJHFHEXPBVULET7CIAZ';
const ISSUER = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';

// Horizon answers newest first. Two calls to the same service at the same price
// are indistinguishable on the ledger: same payer, recipient, asset and amount.
const paymentsPage = [
  { transaction_hash: 'b'.repeat(64), created_at: '2026-08-17T08:55:27Z' },
  { transaction_hash: 'a'.repeat(64), created_at: '2026-08-17T08:50:43Z' }
].map((row) => ({
  ...row,
  type: 'invoke_host_function',
  asset_balance_changes: [{
    asset_type: 'credit_alphanum4', asset_code: 'USDC', asset_issuer: ISSUER,
    type: 'transfer', from: PAYER, to: PAY_TO, amount: '0.0020000'
  }]
}));

vi.mock('$lib/server/security/egress', () => ({
  safeExternalFetch: async () => ({
    response: new Response(JSON.stringify({ _embedded: { records: paymentsPage } }), {
      status: 200, headers: { 'content-type': 'application/json' }
    })
  }),
  readBoundedResponse: async (response: Response) => response.json()
}));

vi.mock('$lib/constants', async (importOriginal) => {
  const actual = await importOriginal<typeof import('$lib/constants')>();
  return {
    ...actual,
    LEAN_V0_NETWORK: {
      ...actual.NETWORK_PROFILES['stellar:testnet'],
      usdcSac: new (await import('@stellar/stellar-sdk')).Asset('USDC', ISSUER)
        .contractId(actual.NETWORK_PROFILES['stellar:testnet'].passphrase)
    }
  };
});

const { findSettlementFromPayer } = await import('./settlement');

/**
 * A job was once marked settled against the receipt of a later job. Both calls
 * cost the same, so the two transfers were identical on the ledger, and the
 * scan returned the newest match, which belonged to the job that came after.
 * The unique index on tx_hash refused the write, and the failure was swallowed,
 * so the Job claimed a payment it did not have.
 */
describe('attributing a settlement to the right job', () => {
  const base = { payer: PAYER, payTo: PAY_TO, amountAtomic: '20000' };

  it('takes the earliest transfer after the job was created, not the newest', async () => {
    const scan = await findSettlementFromPayer({ ...base, sinceIso: '2026-08-17T08:49:56Z' });
    expect(scan).toEqual({ status: 'found', txHash: 'a'.repeat(64) });
  });

  it('never returns a transaction another payment already recorded', async () => {
    const scan = await findSettlementFromPayer({
      ...base, sinceIso: '2026-08-17T08:49:56Z', claimed: ['a'.repeat(64)]
    });
    expect(scan).toEqual({ status: 'found', txHash: 'b'.repeat(64) });
  });

  it('reports absence when every candidate is already claimed', async () => {
    const scan = await findSettlementFromPayer({
      ...base, sinceIso: '2026-08-17T08:49:56Z', claimed: ['a'.repeat(64), 'b'.repeat(64)]
    });
    expect(scan).toEqual({ status: 'absent' });
  });

  it('ignores transfers that predate the job', async () => {
    const scan = await findSettlementFromPayer({ ...base, sinceIso: '2026-08-17T09:00:00Z' });
    expect(scan).toEqual({ status: 'absent' });
  });
});
