import { describe, expect, it } from 'vitest';
import { jobCardFromRow } from './job-card';
import type { JobRow, PaymentRow } from './jobs';
import type { CatalogResource } from '$lib/types/catalog';

const resource: CatalogResource = {
  key: 'stellar8004:13:summarize',
  source: 'stellar8004',
  agent8004Id: 13,
  name: 'Algoria Provider',
  description: 'Deterministic summarize',
  endpoint: 'https://provider.example/api/provider/summarize',
  protocols: ['http', 'x402'],
  evidence: { identity: 'on-chain-8004', reputationStatus: 'declared', labels: [] },
  executionStatus: 'ready',
  rawSourceIds: []
};

function jobRow(overrides: Partial<JobRow> = {}): JobRow {
  return {
    id: 'job-1',
    user_id: 'user-1',
    conversation_id: 'conv-1',
    state: 'awaiting-payment',
    protocol: 'x402',
    endpoint: resource.endpoint,
    request_content: {
      prompt: 'summarize this',
      arguments: { type: 'http' },
      snapshot: {
        method: 'POST',
        url: resource.endpoint,
        correlationId: '3f0b89ab-3f65-45c7-b7a3-0f6d3c1b2a4d',
        recoveryToken: 'a'.repeat(43)
      },
      paymentRequired: 'header-value'
    },
    service_snapshot: resource,
    result_content: null,
    agent_8004_id: 13,
    failure_code: null,
    created_at: new Date().toISOString(),
    network: 'stellar:testnet',
    ...overrides
  };
}

function paymentRow(overrides: Partial<PaymentRow> = {}): PaymentRow {
  return {
    id: 'pay-1',
    job_id: 'job-1',
    protocol: 'x402',
    network: 'stellar:testnet',
    asset: 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA',
    amount_atomic: '100000',
    pay_to: 'G'.padEnd(56, 'A'),
    quote_hash: 'hash',
    status: 'quoted',
    quote_expires_at: new Date(Date.now() + 60_000).toISOString(),
    expires_at: new Date(Date.now() + 60_000).toISOString(),
    tx_hash: null,
    ...overrides
  };
}

describe('authoritative job card', () => {
  it('rebuilds an awaiting-payment card with the exact quote', () => {
    const card = jobCardFromRow(jobRow(), paymentRow());
    expect(card.state).toBe('awaiting-payment');
    expect(card.correlationId).toBe('3f0b89ab-3f65-45c7-b7a3-0f6d3c1b2a4d');
    expect(card.payment).toMatchObject({
      amountAtomic: '100000',
      amountUsdc: '0.01',
      protocol: 'x402',
      quoteId: 'pay-1',
      paymentRequired: 'header-value'
    });
  });

  it('tolerates Postgres numeric amounts arriving as JSON numbers', () => {
    const card = jobCardFromRow(jobRow(), paymentRow({ amount_atomic: 100000 }));
    expect(card.payment).toMatchObject({ amountAtomic: '100000', amountUsdc: '0.01' });
  });

  it('keeps an expired quote visible so a new quote can be requested', () => {
    const card = jobCardFromRow(jobRow(), paymentRow({ status: 'expired' }));
    expect(card.payment?.quoteId).toBe('pay-1');
  });

  it('drops the payment block once the quote is claimed', () => {
    const card = jobCardFromRow(jobRow(), paymentRow({ status: 'signed' }));
    expect(card.payment).toBeUndefined();
  });

  it('maps failure codes to user-facing recovery copy', () => {
    const card = jobCardFromRow(
      jobRow({ state: 'payment-uncertain', failure_code: 'payment_outcome_uncertain' }),
      paymentRow({ status: 'reconciling' })
    );
    expect(card.error).toContain('Do not pay again');
  });

  it('surfaces the settlement transaction on a completed result', () => {
    const card = jobCardFromRow(
      jobRow({ state: 'succeeded', result_content: { artifact: 'summary' } }),
      paymentRow({ status: 'settled', tx_hash: 'deadbeef' })
    );
    expect(card.result).toEqual({ status: 0, body: { artifact: 'summary' }, txHash: 'deadbeef' });
    expect(card.error).toBeUndefined();
  });

  it('describes paid HTTP failures with their status code', () => {
    const card = jobCardFromRow(jobRow({ state: 'failed', failure_code: 'paid_http_502' }), paymentRow({ status: 'settled' }));
    expect(card.error).toBe('Payment settled, but the agent returned 502');
  });

  /**
   * A reload rebuilds the card from the database, so an entry missing here made
   * the rating control reappear on a job that had already been rated, offering
   * a second entry the table refuses.
   */
  it('carries a reputation entry that has already been written', () => {
    const feedback = {
      id: 'f1', user_id: 'u1', job_id: 'j1', agent_8004_id: 67, score: 100,
      tag1: 'helpful', tag2: null, tx_hash: 'a'.repeat(64), status: 'confirmed' as const
    };
    const card = jobCardFromRow(jobRow({ state: 'succeeded' }), paymentRow({ status: 'settled' }), feedback);
    expect(card.feedback).toEqual({ status: 'confirmed', score: 100, tag: 'helpful', txHash: 'a'.repeat(64) });
  });

  it('leaves the card free of one when no entry exists', () => {
    expect(jobCardFromRow(jobRow({ state: 'succeeded' }), paymentRow({ status: 'settled' })).feedback).toBeUndefined();
    expect(jobCardFromRow(jobRow({ state: 'succeeded' }), paymentRow({ status: 'settled' }), null).feedback).toBeUndefined();
  });
});
