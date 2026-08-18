import { createHash } from 'node:crypto';
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireAuth } from '$lib/server/auth/require';
import { audit, claimPayment, claimedTxHashes, committedSpendAtomic, getOwnedJob, getPayment, updateJob, updatePayment, updatePersistedJobMessage } from '$lib/server/db/jobs';
import { LEAN_V0_DAILY_SPEND_USDC, LEAN_V0_SPEND_WINDOW_HOURS } from '$lib/constants';
import { usdcToAtomic } from '$lib/utils/money';
import { responseResult, sendSnapshot } from '$lib/server/execution/http';
import { parseX402Quote, quoteHash, settlementTransaction, validatePaymentSignature } from '$lib/server/payments/x402';
import { fetchProviderRecovery, type ProviderRecovery } from '$lib/server/payments/recovery';
import { findSettlementFromPayer, verifySettlementOnChain } from '$lib/server/payments/settlement';
import { safeErrorMessage } from '$lib/server/shared/sanitize';
import { readBoundedJsonObject } from '$lib/server/security/body';
import type { JobCard } from '$lib/types/chat';

function hash(value: string) {
  return createHash('sha256').update(value).digest('hex');
}

export const POST: RequestHandler = async (event) => {
  const { auth } = requireAuth(event);
  const job = await getOwnedJob(auth.userId, event.params.id);
  if (!job) return json({ message: 'Job not found' }, { status: 404 });
  const payment = await getPayment(job.id);
  if (!payment || payment.status !== 'quoted') return json({ message: 'This payment quote is no longer available' }, { status: 409 });
  if (payment.protocol !== 'x402') {
    return json({ code: 'unsupported-policy', message: 'Only exact x402 payment is enabled in lean v0' }, { status: 501 });
  }
  if (new Date(payment.quote_expires_at).getTime() <= Date.now()) {
    await updatePayment(payment.id, { status: 'expired' });
    return json({ code: 'quote-expired', message: 'The payment quote expired before signing. Request a new quote to continue.' }, { status: 410 });
  }
  const input = await readBoundedJsonObject(event.request).catch((): Record<string, unknown> => ({}));
  const credential = typeof input.credential === 'string' ? input.credential : '';
  const requestContent = job.request_content;
  const snapshot = requestContent?.snapshot;
  if (!snapshot) return json({ message: 'The retained request snapshot is unavailable' }, { status: 410 });
  const rawQuote = requestContent.paymentRequired ?? '';
  if (!rawQuote || quoteHash(rawQuote) !== payment.quote_hash) {
    return json({ message: 'The stored x402 quote no longer matches this job; request a new quote' }, { status: 409 });
  }

  // The per-payment cap bounds one signature; this bounds a run of them.
  const windowStart = new Date(Date.now() - LEAN_V0_SPEND_WINDOW_HOURS * 3_600_000).toISOString();
  const committed = await committedSpendAtomic(auth.userId, windowStart).catch(() => null);
  if (committed !== null && committed + BigInt(String(payment.amount_atomic)) > BigInt(usdcToAtomic(LEAN_V0_DAILY_SPEND_USDC))) {
    return json({
      code: 'spend-limit',
      message: `This wallet has reached the ${LEAN_V0_DAILY_SPEND_USDC} USDC rolling ${LEAN_V0_SPEND_WINDOW_HOURS}-hour limit. No payment was signed.`
    }, { status: 429 });
  }

  /**
   * The facilitator's claim is not proof. Only a transfer of the approved amount to
   * the approved recipient, found on the ledger, marks a payment settled; anything
   * else stays `reconciling` for operator review instead of becoming a false receipt.
   */
  const receiptFor = async (reference: string) => {
    const verdict = await verifySettlementOnChain(reference, {
      amountAtomic: String(payment.amount_atomic),
      payTo: payment.pay_to
    });
    await audit(auth.userId, 'payment.verify', 'job', job.id, verdict.status).catch(() => undefined);
    return {
      verdict,
      update: verdict.status === 'verified'
        ? { status: 'settled' as const, tx_hash: reference }
        : { status: 'reconciling' as const, tx_hash: reference }
    };
  };

  const finishRecoveredSuccess = async (recovery: ProviderRecovery) => {
    const settlementReference = recovery.result.txHash!;
    const card: JobCard = {
      id: job.id,
      prompt: requestContent.prompt,
      selected: job.service_snapshot,
      arguments: requestContent.arguments,
      correlationId: snapshot.correlationId,
      state: 'succeeded',
      result: recovery.result
    };
    await updatePayment(payment.id, (await receiptFor(settlementReference)).update).catch(() => undefined);
    await updateJob(job.id, { state: 'succeeded', failure_code: null, result_content: recovery.result.body }).catch(() => undefined);
    await updatePersistedJobMessage(job.conversation_id, card).catch(() => undefined);
    await audit(auth.userId, 'payment.recover', 'job', job.id, 'succeeded').catch(() => undefined);
    return json({ job: card, recovered: true });
  };

  const finishRecoveredFailure = async (recovery: ProviderRecovery) => {
    const card: JobCard = {
      id: job.id,
      prompt: requestContent.prompt,
      selected: job.service_snapshot,
      arguments: requestContent.arguments,
      correlationId: snapshot.correlationId,
      state: 'failed',
      result: recovery.result,
      error: 'The provider recorded a terminal settlement failure; no second payment should be submitted.'
    };
    await updatePayment(payment.id, { status: 'failed' }).catch(() => undefined);
    await updateJob(job.id, { state: 'failed', failure_code: 'provider_settlement_failed', result_content: recovery.result.body }).catch(() => undefined);
    await updatePersistedJobMessage(job.conversation_id, card).catch(() => undefined);
    await audit(auth.userId, 'payment.recover', 'job', job.id, 'failed').catch(() => undefined);
    return json({ job: card, recovered: true, message: card.error }, { status: 502 });
  };

  let claimed = false;
  let settlementReference: string | undefined;
  try {
    const quote = parseX402Quote(rawQuote);
    validatePaymentSignature(credential, quote.requirement);
    const header = { name: 'PAYMENT-SIGNATURE' as const, value: credential };
    await claimPayment(payment.id, hash(credential));
    claimed = true;
    const { response } = await sendSnapshot(snapshot, header);
    settlementReference = settlementTransaction(response.headers.get('payment-response') ?? response.headers.get('x-payment-response'));
    const result = await responseResult(response);
    if (!response.ok) {
      if (!settlementReference) {
        const recovery = await fetchProviderRecovery(snapshot).catch(() => null);
        if (recovery?.kind === 'succeeded') return finishRecoveredSuccess(recovery);
        if (recovery?.kind === 'failed') return finishRecoveredFailure(recovery);
      }
      // A 402 to a paid request means the service is still asking to be paid, so
      // it did not accept this credential. If the ledger also shows the approved
      // transfer never happened, the honest answer is that nothing was charged,
      // not that the outcome is unknown. Both signals are required: a Horizon
      // failure or any other status keeps the conservative uncertain state.
      let notCharged = false;
      if (!settlementReference && response.status === 402) {
        const scan = await findSettlementFromPayer({
          payer: auth.walletAddress,
          payTo: payment.pay_to,
          amountAtomic: String(payment.amount_atomic),
          sinceIso: job.created_at,
          // An earlier job's receipt must never answer this one's question.
          claimed: await claimedTxHashes(auth.userId).catch(() => [] as string[])
        }).catch(() => ({ status: 'unavailable' as const }));
        notCharged = scan.status === 'absent';
        await audit(auth.userId, 'payment.scan', 'job', job.id, scan.status).catch(() => undefined);
      }
      const state = settlementReference ? 'failed' : notCharged ? 'failed' : 'payment-uncertain';
      const message = settlementReference
        ? `Payment settled, but the agent returned ${response.status}`
        : notCharged
          ? 'The service did not accept the payment and the ledger shows nothing was charged. You can try again.'
          : `The paid request returned ${response.status}. Do not pay again; use Check status to re-verify.`;
      const card: JobCard = {
        id: job.id, prompt: requestContent.prompt, selected: job.service_snapshot, arguments: requestContent.arguments, correlationId: snapshot.correlationId,
        state, result: { ...result, txHash: settlementReference }, error: message
      };
      await updatePayment(payment.id, settlementReference
        ? (await receiptFor(settlementReference)).update
        : { status: 'reconciling' });
      await updateJob(job.id, {
        state,
        failure_code: settlementReference ? `paid_http_${response.status}` : notCharged ? 'payment_not_accepted' : 'payment_outcome_uncertain',
        result_content: result.body
      });
      await updatePersistedJobMessage(job.conversation_id, card);
      await audit(auth.userId, 'payment.settle', 'job', job.id, state);
      // 202 means "unresolved, do not act"; a proven-unpaid outcome is resolved.
      return json({ job: card, message }, { status: settlementReference || notCharged ? 502 : 202 });
    }
    if (!settlementReference) {
      const recovery = await fetchProviderRecovery(snapshot).catch(() => null);
      if (recovery?.kind === 'succeeded') return finishRecoveredSuccess(recovery);
      if (recovery?.kind === 'failed') return finishRecoveredFailure(recovery);
      const message = 'The service responded without verifiable settlement evidence. Do not pay again; use Check status to re-verify.';
      const card: JobCard = {
        id: job.id,
        prompt: requestContent.prompt,
        selected: job.service_snapshot,
        arguments: requestContent.arguments,
        correlationId: snapshot.correlationId,
        state: 'payment-uncertain',
        result,
        error: message
      };
      await updatePayment(payment.id, { status: 'reconciling' });
      await updateJob(job.id, { state: 'payment-uncertain', failure_code: 'settlement_evidence_missing', result_content: result.body });
      await updatePersistedJobMessage(job.conversation_id, card);
      await audit(auth.userId, 'payment.settle', 'job', job.id, 'settlement-evidence-missing');
      return json({ job: card, message }, { status: 202 });
    }
    const receipt = await receiptFor(settlementReference);
    const card: JobCard = {
      id: job.id, prompt: requestContent.prompt, selected: job.service_snapshot, arguments: requestContent.arguments, correlationId: snapshot.correlationId,
      state: 'succeeded', result: { ...result, txHash: settlementReference },
      ...(receipt.verdict.status === 'mismatch'
        ? { error: 'The result arrived, but the payment receipt does not match the approved transfer on the ledger. Do not pay again; an operator will review it.' }
        : {})
    };
    await updatePayment(payment.id, receipt.update);
    await updateJob(job.id, { state: 'succeeded', result_content: result.body });
    await updatePersistedJobMessage(job.conversation_id, card);
    await audit(auth.userId, 'payment.settle', 'job', job.id, `succeeded:${receipt.verdict.status}`);
    return json({ job: card });
  } catch (error) {
    if (claimed) {
      if (!settlementReference) {
        const recovery = await fetchProviderRecovery(snapshot).catch(() => null);
        if (recovery?.kind === 'succeeded') return finishRecoveredSuccess(recovery);
        if (recovery?.kind === 'failed') return finishRecoveredFailure(recovery);
      }
      const message = settlementReference
        ? 'Payment settled, but the agent response could not be completed.'
        : 'Payment outcome is uncertain. Do not pay again; use Check status to re-verify.';
      const state = settlementReference ? 'failed' : 'payment-uncertain';
      const card: JobCard = {
        id: job.id, prompt: requestContent.prompt, selected: job.service_snapshot, arguments: requestContent.arguments, correlationId: snapshot.correlationId,
        state, error: message, result: settlementReference ? { status: 0, body: null, txHash: settlementReference } : undefined
      };
      await updatePayment(payment.id, settlementReference
        ? { status: 'settled', tx_hash: settlementReference }
        : { status: 'reconciling' }).catch(() => undefined);
      await updateJob(job.id, { state, failure_code: settlementReference ? 'paid_response_failed' : 'payment_outcome_uncertain' }).catch(() => undefined);
      await updatePersistedJobMessage(job.conversation_id, card).catch(() => undefined);
      await audit(auth.userId, 'payment.settle', 'job', job.id, state).catch(() => undefined);
      return json({ job: card, message }, { status: settlementReference ? 502 : 202 });
    }
    await audit(auth.userId, 'payment.settle', 'job', job.id, 'failed').catch(() => undefined);
    return json({ message: safeErrorMessage(error) }, { status: 400 });
  }
};
