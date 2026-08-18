import { describe, expect, it } from 'vitest';
import { encodePaymentRequiredHeader, encodePaymentSignatureHeader } from '@x402/core/http';
import type { PaymentPayload, PaymentRequired } from '@x402/core/types';
import { LEAN_V0_NETWORK } from '$lib/constants';
import { parseX402Quote, validatePaymentSignature } from './x402';

const payTo = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';
const requirement = {
  scheme: 'exact', network: LEAN_V0_NETWORK.caip2, asset: LEAN_V0_NETWORK.usdcSac,
  amount: '1000000', payTo, maxTimeoutSeconds: 60, extra: {}
} as const;

describe('x402 quote policy', () => {
  it('accepts an exact Stellar testnet USDC quote under the cap', () => {
    const required: PaymentRequired = { x402Version: 2, resource: { url: 'https://example.com/task' }, accepts: [requirement] };
    const parsed = parseX402Quote(encodePaymentRequiredHeader(required));
    expect(parsed.option.amountUsdc).toBe('0.1');
  });

  it('rejects pubnet, cap, and signed-quote mismatches', () => {
    const pubnet: PaymentRequired = {
      x402Version: 2,
      resource: { url: 'https://example.com/task' },
      accepts: [{ ...requirement, network: 'stellar:pubnet' }]
    };
    expect(() => parseX402Quote(encodePaymentRequiredHeader(pubnet))).toThrow(/testnet/);
    const expensive: PaymentRequired = { x402Version: 2, resource: { url: 'https://example.com/task' }, accepts: [{ ...requirement, amount: '10000001' }] };
    expect(() => parseX402Quote(encodePaymentRequiredHeader(expensive))).toThrow(/cap/);
    const payload: PaymentPayload = { x402Version: 2, accepted: { ...requirement, payTo: `G${'B'.repeat(55)}` }, payload: {} };
    expect(() => validatePaymentSignature(encodePaymentSignatureHeader(payload), requirement)).toThrow(/payTo/);
  });
});
