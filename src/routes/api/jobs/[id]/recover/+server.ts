import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireAuth } from '$lib/server/auth/require';
import { audit, claimedTxHashes, getFeedbackAction, getOwnedJob, getPayment, updateJobWhen, updatePayment, updatePersistedJobMessage } from '$lib/server/db/jobs';
import { jobCardFromRow } from '$lib/server/db/job-card';
import { fetchProviderRecovery } from '$lib/server/payments/recovery';
import { findSettlementFromPayer, verifySettlementOnChain } from '$lib/server/payments/settlement';

// The unpaid probe times out after 15s; only a probe at least this stale can be declared lost.
const PROBE_RECOVERY_AGE_MS = 120_000;

/**
 * Re-drives recovery for a Job whose outcome was lost, from two sources that
 * answer different questions. A same-origin, token-authenticated provider
 * status lookup can return the work itself. The ledger cannot do that, but it
 * settles the question that costs money, whether anything was charged, and it
 * answers for every service, including the ones that publish no status endpoint
 * at all. Neither path ever resubmits a payment credential, and a Job is marked
 * succeeded only against settlement evidence. It always returns the
 * authoritative Job Card.
 */
export const POST: RequestHandler = async (event) => {
  const { auth } = requireAuth(event);
  const job = await getOwnedJob(auth.userId, event.params.id);
  if (!job) return json({ message: 'Job not found' }, { status: 404 });
  const payment = await getPayment(job.id);

  const respond = async (recovered: boolean, message?: string) => {
    const fresh = await getOwnedJob(auth.userId, job.id) ?? job;
    const freshPayment = await getPayment(job.id);
    const card = jobCardFromRow(fresh, freshPayment, await getFeedbackAction(job.id).catch(() => null));
    await updatePersistedJobMessage(fresh.conversation_id, card).catch(() => undefined);
    return json({ job: card, recovered, ...(message ? { message } : {}) });
  };

  if (job.state === 'probing') {
    // No payment exists before a 402, so a lost probe can be closed safely.
    if (payment) return respond(false);
    if (Date.now() - new Date(job.created_at).getTime() < PROBE_RECOVERY_AGE_MS) {
      return respond(false, 'The approved request may still be running; check again shortly.');
    }
    const updated = await updateJobWhen(job.id, ['probing'], { state: 'failed', failure_code: 'probe_lost' });
    if (updated) await audit(auth.userId, 'job.recover', 'job', job.id, 'probe-lost').catch(() => undefined);
    return respond(Boolean(updated));
  }

  if (job.state !== 'executing' && job.state !== 'payment-uncertain') return respond(false);

  const snapshot = job.request_content?.snapshot;
  if (!snapshot) return respond(false, 'The retained request snapshot is unavailable; operator review is required.');

  const recovery = await fetchProviderRecovery(snapshot).catch(() => null);
  if (recovery?.kind === 'succeeded') {
    // Recovered evidence gets the same ledger check as a live settlement.
    if (payment) {
      const verdict = await verifySettlementOnChain(recovery.result.txHash!, {
        amountAtomic: String(payment.amount_atomic),
        payTo: payment.pay_to
      });
      await audit(auth.userId, 'payment.verify', 'job', job.id, verdict.status).catch(() => undefined);
      await updatePayment(payment.id, {
        status: verdict.status === 'verified' ? 'settled' : 'reconciling',
        tx_hash: recovery.result.txHash!
      }).catch(() => undefined);
    }
    const updated = await updateJobWhen(job.id, ['executing', 'payment-uncertain'], {
      state: 'succeeded', failure_code: null, result_content: recovery.result.body
    }).catch(() => null);
    if (updated) await audit(auth.userId, 'payment.recover', 'job', job.id, 'succeeded').catch(() => undefined);
    return respond(true);
  }
  if (recovery?.kind === 'failed') {
    if (payment) await updatePayment(payment.id, { status: 'failed' }).catch(() => undefined);
    const updated = await updateJobWhen(job.id, ['executing', 'payment-uncertain'], {
      state: 'failed', failure_code: 'provider_settlement_failed', result_content: recovery.result.body
    }).catch(() => null);
    if (updated) await audit(auth.userId, 'payment.recover', 'job', job.id, 'failed').catch(() => undefined);
    return respond(true, 'The provider recorded a terminal settlement failure; no second payment should be submitted.');
  }
  if (recovery?.kind === 'processing') {
    return respond(false, 'The paid request is still processing. Do not pay again; check the status again shortly.');
  }

  // The provider lookup is the only way to recover a lost *result*, but it is not
  // the only way to answer the question that costs money: was anything charged?
  // A service that offers no status endpoint leaves the result unrecoverable
  // while the ledger still holds the settlement, so a payment that plainly went
  // through stopped being reported as uncertain only because the service had
  // declined to say so. The ledger is asked directly now.
  if (payment && !payment.tx_hash && ['signed', 'reconciling'].includes(payment.status)) {
    const expected = { amountAtomic: String(payment.amount_atomic), payTo: payment.pay_to };
    const claimed = await claimedTxHashes(auth.userId).catch(() => [] as string[]);
    const scan = await findSettlementFromPayer({
      payer: auth.walletAddress,
      ...expected,
      sinceIso: job.created_at,
      claimed
    }).catch(() => ({ status: 'unavailable' as const }));

    if (scan.status === 'found') {
      const verdict = await verifySettlementOnChain(scan.txHash, expected);
      await audit(auth.userId, 'payment.verify', 'job', job.id, verdict.status).catch(() => undefined);
      if (verdict.status === 'verified') {
        // The receipt must be recorded before the Job claims to be settled. A
        // failure here means the transaction is already recorded against a
        // different payment, so this Job has not been paid for after all and
        // must not inherit that receipt.
        const recorded = await updatePayment(payment.id, { status: 'settled', tx_hash: scan.txHash })
          .then(() => true).catch(() => false);
        if (!recorded) {
          await audit(auth.userId, 'payment.recover', 'job', job.id, 'receipt-conflict').catch(() => undefined);
          return respond(false, 'The ledger transaction found for this job is already recorded against another payment; operator review is required.');
        }
        // The paid call did return the work; only its receipt was missing.
        const outcome = job.result_content
          ? { state: 'succeeded' as const, failure_code: null }
          : { state: 'failed' as const, failure_code: 'result_lost_after_settlement' };
        const updated = await updateJobWhen(job.id, ['executing', 'payment-uncertain'], outcome).catch(() => null);
        if (updated) await audit(auth.userId, 'payment.recover', 'job', job.id, `ledger-${outcome.state}`).catch(() => undefined);
        return respond(Boolean(updated), job.result_content
          ? undefined
          : 'The payment settled on the ledger, but this service cannot return the result again. Do not pay again.');
      }
    }

    if (scan.status === 'absent') {
      await updatePayment(payment.id, { status: 'failed' }).catch(() => undefined);
      const updated = await updateJobWhen(job.id, ['executing', 'payment-uncertain'], {
        state: 'failed', failure_code: 'payment_not_accepted'
      }).catch(() => null);
      if (updated) await audit(auth.userId, 'payment.scan', 'job', job.id, 'absent').catch(() => undefined);
      return respond(Boolean(updated), 'The ledger shows nothing was charged. You can try again.');
    }
  }

  // Recovery is uncertain or unavailable. Make a claimed-but-lost payment visible as such.
  if (job.state === 'executing' && payment && ['signed', 'reconciling'].includes(payment.status)) {
    if (payment.status === 'signed') await updatePayment(payment.id, { status: 'reconciling' }).catch(() => undefined);
    await updateJobWhen(job.id, ['executing'], { state: 'payment-uncertain', failure_code: 'payment_outcome_uncertain' }).catch(() => null);
    await audit(auth.userId, 'job.recover', 'job', job.id, 'payment-uncertain').catch(() => undefined);
  }
  return respond(false, 'Settlement is still uncertain. Do not pay again; operator review is required.');
};
