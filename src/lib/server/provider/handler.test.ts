import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  decodePaymentRequiredHeader,
  decodePaymentResponseHeader,
  encodePaymentSignatureHeader
} from '@x402/core/http';
import type {
  PaymentPayload,
  PaymentRequirements,
  SettleResponse,
  SupportedResponse,
  VerifyResponse
} from '@x402/core/types';
import type { FacilitatorClient } from '@x402/core/server';
import { LEAN_V0_NETWORK } from '$lib/constants';
import { canRecoverProviderRun, handleProviderRequest, providerStatusResponse } from './handler';
import { createProviderPaymentServer } from './x402';
import type { ProviderRun, ProviderRunStore } from './store';
import type { ProviderServiceName } from './services';

const payTo = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';
const payer = `G${'B'.repeat(55)}`;
const recoveryToken = 'R'.repeat(43);

class FakeFacilitator implements FacilitatorClient {
  verifyCalls = 0;
  settleCalls = 0;

  constructor(private readonly settlement: 'success' | 'terminal' | 'throw' = 'success') {}

  async getSupported(): Promise<SupportedResponse> {
    return {
      kinds: [{ x402Version: 2, scheme: 'exact', network: LEAN_V0_NETWORK.caip2, extra: { areFeesSponsored: true } }],
      extensions: [],
      signers: { 'stellar:*': [payer] }
    };
  }

  async verify(_payload: PaymentPayload, _requirements: PaymentRequirements): Promise<VerifyResponse> {
    this.verifyCalls += 1;
    return { isValid: true, payer };
  }

  async settle(_payload: PaymentPayload, requirements: PaymentRequirements): Promise<SettleResponse> {
    this.settleCalls += 1;
    if (this.settlement === 'throw') throw new Error('facilitator timeout');
    if (this.settlement === 'terminal') {
      return {
        success: false,
        errorReason: 'invalid_payload',
        errorMessage: 'The payment payload is terminally invalid',
        transaction: '',
        network: requirements.network,
        payer
      };
    }
    return {
      success: true,
      transaction: 'testnet-settlement-1',
      network: requirements.network,
      amount: requirements.amount,
      payer
    };
  }
}

function memoryStore(): ProviderRunStore {
  const rows = new Map<string, ProviderRun>();
  const now = () => new Date().toISOString();
  return {
    async get(id) { return rows.get(id) ?? null; },
    async claim(id, service, requestHash, recoveryTokenHash) {
      const existing = rows.get(id);
      if (existing) return { claimed: false, run: existing };
      const created: ProviderRun = {
        correlation_id: id,
        service,
        request_hash: requestHash,
        recovery_token_hash: recoveryTokenHash,
        status: 'processing',
        artifact: null,
        payment_receipt: null,
        payment_response: null,
        failure_code: null,
        created_at: now(),
        updated_at: now(),
        expires_at: now()
      };
      rows.set(id, created);
      return { claimed: true, run: created };
    },
    async succeed(id, artifact, receipt, paymentResponse) {
      const updated = { ...rows.get(id)!, status: 'succeeded' as const, artifact, payment_receipt: receipt, payment_response: paymentResponse, updated_at: now() };
      rows.set(id, updated);
      return updated;
    },
    async fail(id, failureCode, uncertain = false) {
      const updated = { ...rows.get(id)!, status: uncertain ? 'uncertain' as const : 'failed' as const, failure_code: failureCode, updated_at: now() };
      rows.set(id, updated);
      return updated;
    }
  };
}

function request(
  service: ProviderServiceName,
  correlationId: string,
  body: unknown,
  paymentSignature?: string,
  token = recoveryToken
) {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json',
    'x-algoria-correlation-id': correlationId,
    'x-algoria-recovery-token': token
  };
  if (paymentSignature) headers['payment-signature'] = paymentSignature;
  return new Request(`https://provider.example/api/provider/${service}`, {
    method: 'POST', headers, body: JSON.stringify(body)
  });
}

async function harness(settlement: 'success' | 'terminal' | 'throw' = 'success') {
  const facilitator = new FakeFacilitator(settlement);
  const server = await createProviderPaymentServer({
    payTo,
    facilitatorUrl: 'https://facilitator.example',
    network: LEAN_V0_NETWORK.caip2,
    asset: LEAN_V0_NETWORK.usdcSac,
    priceAtomic: '100000'
  }, facilitator);
  return { facilitator, server, store: memoryStore() };
}

async function paymentFor(response: Response): Promise<string> {
  const encoded = response.headers.get('payment-required');
  expect(encoded).toBeTruthy();
  const required = decodePaymentRequiredHeader(encoded!);
  expect(required.accepts).toHaveLength(1);
  const accepted = required.accepts[0];
  expect(accepted).toMatchObject({
    scheme: 'exact',
    network: LEAN_V0_NETWORK.caip2,
    asset: LEAN_V0_NETWORK.usdcSac,
    amount: '100000',
    payTo
  });
  return encodePaymentSignatureHeader({
    x402Version: 2,
    resource: required.resource,
    accepted,
    payload: { authorization: 'controlled-test-signature' }
  });
}

describe('controlled provider x402 contract', () => {
  it('challenges, settles once, returns an Artifact and Payment Receipt, then serves replay from recovery state', async () => {
    const { facilitator, server, store } = await harness();
    const correlationId = randomUUID();
    const body = { text: 'One. Two. Three.', maxSentences: 2 };
    const unpaid = await handleProviderRequest(request('summarize', correlationId, body), 'summarize', { paymentServer: server, store });
    expect(unpaid.status).toBe(402);
    const signature = await paymentFor(unpaid);

    const paid = await handleProviderRequest(request('summarize', correlationId, body, signature), 'summarize', { paymentServer: server, store });
    expect(paid.status).toBe(200);
    const result = await paid.json();
    expect(result.artifact).toMatchObject({ kind: 'summary', summary: 'One. Two.' });
    expect(result.paymentReceipt).toMatchObject({
      protocol: 'x402', network: LEAN_V0_NETWORK.caip2, asset: LEAN_V0_NETWORK.usdcSac,
      amountAtomic: '100000', amountUsdc: '0.01', settlementReference: 'testnet-settlement-1', correlationId
    });
    expect(decodePaymentResponseHeader(paid.headers.get('payment-response')!)).toMatchObject({
      success: true, transaction: 'testnet-settlement-1', network: LEAN_V0_NETWORK.caip2
    });

    const replay = await handleProviderRequest(request('summarize', correlationId, body, signature), 'summarize', { paymentServer: server, store });
    expect(replay.status).toBe(200);
    expect(facilitator.verifyCalls).toBe(1);
    expect(facilitator.settleCalls).toBe(1);
  });

  it('recovers a deliberately lost response by correlation id without settling again', async () => {
    const { facilitator, server, store } = await harness();
    const correlationId = randomUUID();
    const body = { text: 'Invoice support requested.', labels: ['sales', 'invoice support'] };
    const signature = await paymentFor(await handleProviderRequest(
      request('classify', correlationId, body), 'classify', { paymentServer: server, store }
    ));
    const lost = await handleProviderRequest(
      request('classify', correlationId, body, signature), 'classify', { paymentServer: server, store, testMode: 'response-loss' }
    );
    expect(lost.status).toBe(503);
    expect(lost.headers.get('payment-response')).toBeNull();

    const recovered = providerStatusResponse((await store.get(correlationId))!);
    expect(recovered.status).toBe(200);
    expect(await recovered.json()).toMatchObject({ status: 'succeeded', artifact: { label: 'invoice support' } });
    expect(canRecoverProviderRun((await store.get(correlationId))!, recoveryToken)).toBe(true);
    expect(canRecoverProviderRun((await store.get(correlationId))!, 'W'.repeat(43))).toBe(false);
    expect(facilitator.settleCalls).toBe(1);
  });

  it('does not reveal or replay an existing run to a different recovery token', async () => {
    const { server, store } = await harness();
    const correlationId = randomUUID();
    const body = { text: 'Private result. Another sentence.', maxSentences: 1 };
    const signature = await paymentFor(await handleProviderRequest(
      request('summarize', correlationId, body), 'summarize', { paymentServer: server, store }
    ));
    expect((await handleProviderRequest(
      request('summarize', correlationId, body, signature), 'summarize', { paymentServer: server, store }
    )).status).toBe(200);

    const denied = await handleProviderRequest(
      request('summarize', correlationId, body, signature, 'W'.repeat(43)),
      'summarize',
      { paymentServer: server, store }
    );
    expect(denied.status).toBe(404);
    expect(await denied.json()).toEqual({ code: 'not-found' });
  });

  it('retries the recovery-state write without repeating settlement', async () => {
    const { facilitator, server, store } = await harness();
    const originalSucceed = store.succeed.bind(store);
    let writes = 0;
    store.succeed = async (...args) => {
      writes += 1;
      if (writes === 1) throw new Error('transient database error');
      return originalSucceed(...args);
    };
    const correlationId = randomUUID();
    const body = { text: 'Retry only the database write.', maxSentences: 1 };
    const signature = await paymentFor(await handleProviderRequest(
      request('summarize', correlationId, body), 'summarize', { paymentServer: server, store }
    ));
    const paid = await handleProviderRequest(
      request('summarize', correlationId, body, signature), 'summarize', { paymentServer: server, store }
    );

    expect(paid.status).toBe(200);
    expect(writes).toBe(2);
    expect(facilitator.settleCalls).toBe(1);
    expect(await store.get(correlationId)).toMatchObject({ status: 'succeeded' });
  });

  it('preserves terminal settlement reasons and marks thrown settlement outcomes uncertain', async () => {
    const terminal = await harness('terminal');
    const terminalId = randomUUID();
    const body = { text: 'Title: Proof', fields: ['title'] };
    const terminalSignature = await paymentFor(await handleProviderRequest(
      request('extract', terminalId, body), 'extract', { paymentServer: terminal.server, store: terminal.store }
    ));
    const terminalResponse = await handleProviderRequest(
      request('extract', terminalId, body, terminalSignature), 'extract', { paymentServer: terminal.server, store: terminal.store }
    );
    expect(terminalResponse.status).toBe(402);
    expect(await terminal.store.get(terminalId)).toMatchObject({ status: 'failed', failure_code: 'settlement:invalid_payload' });

    const uncertain = await harness('throw');
    const uncertainId = randomUUID();
    const uncertainSignature = await paymentFor(await handleProviderRequest(
      request('extract', uncertainId, body), 'extract', { paymentServer: uncertain.server, store: uncertain.store }
    ));
    const uncertainResponse = await handleProviderRequest(
      request('extract', uncertainId, body, uncertainSignature), 'extract', { paymentServer: uncertain.server, store: uncertain.store }
    );
    expect(uncertainResponse.status).toBe(202);
    expect(await uncertain.store.get(uncertainId)).toMatchObject({ status: 'uncertain', failure_code: 'settlement:facilitator timeout' });
  });

  it('rejects malformed work before facilitator verification', async () => {
    const { facilitator, server, store } = await harness();
    const response = await handleProviderRequest(
      request('summarize', randomUUID(), { text: '', maxSentences: 50 }),
      'summarize',
      { paymentServer: server, store }
    );
    expect(response.status).toBe(400);
    expect(facilitator.verifyCalls).toBe(0);
    expect(facilitator.settleCalls).toBe(0);
  });
});
