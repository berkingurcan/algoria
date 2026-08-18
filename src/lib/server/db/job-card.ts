import type { JobCard } from '$lib/types/chat';
import { atomicToUsdc } from '$lib/utils/money';
import type { FeedbackRow, JobRow, PaymentRow } from './jobs';

const FAILURE_MESSAGES: Record<string, string> = {
  payment_outcome_uncertain: 'Payment outcome is uncertain. Do not pay again; use Check status to re-verify.',
  payment_not_accepted: 'The service did not accept the payment and the ledger shows nothing was charged. You can try again.',
  settlement_evidence_missing: 'The service responded without verifiable settlement evidence. Do not pay again; use Check status to re-verify.',
  provider_settlement_failed: 'The provider recorded a terminal settlement failure; no second payment should be submitted.',
  paid_response_failed: 'Payment settled, but the agent response could not be completed.',
  probe_lost: 'The approved request did not complete. No payment was made; you can run it again.',
  missing_input: 'More detail is needed before this request can run.',
  execution_failed: 'The approved request could not be completed.'
};

function failureMessage(code: string | null): string | undefined {
  if (!code) return undefined;
  if (FAILURE_MESSAGES[code]) return FAILURE_MESSAGES[code];
  const httpStatus = /^(?:paid_)?http_(\d{3})$/.exec(code);
  if (httpStatus) {
    return code.startsWith('paid_')
      ? `Payment settled, but the agent returned ${httpStatus[1]}`
      : `Agent endpoint returned ${httpStatus[1]}`;
  }
  return 'The approved request could not be completed.';
}

/**
 * Rebuilds the authoritative Job Card from the jobs row and its payment record.
 *
 * The reputation entry belongs here too. Without it a reload rebuilt the card
 * from the database alone, the rating control came back on a job that had
 * already been rated, and the interface offered a second entry the table would
 * refuse, an affordance for something that cannot happen.
 */
export function jobCardFromRow(row: JobRow, payment: PaymentRow | null, feedback?: FeedbackRow | null): JobCard {
  const requestContent = row.request_content;
  const card: JobCard = {
    id: row.id,
    state: row.state,
    prompt: requestContent?.prompt ?? '',
    selected: row.service_snapshot,
    arguments: requestContent?.arguments,
    correlationId: requestContent?.snapshot?.correlationId
  };
  if (row.result_content !== null && row.result_content !== undefined) {
    card.result = { status: 0, body: row.result_content, txHash: payment?.tx_hash ?? undefined };
  }
  if (payment && row.state === 'awaiting-payment' && ['quoted', 'expired'].includes(payment.status) && requestContent?.paymentRequired) {
    const amountAtomic = String(payment.amount_atomic);
    card.payment = {
      scheme: 'exact',
      network: payment.network,
      asset: payment.asset,
      amountAtomic,
      amountUsdc: atomicToUsdc(amountAtomic),
      payTo: payment.pay_to,
      protocol: payment.protocol,
      quoteId: payment.id,
      expiresAt: payment.quote_expires_at,
      paymentRequired: requestContent.paymentRequired,
      recoverable: Boolean(requestContent.snapshot?.recoveryUrl)
    };
  }
  if (feedback) {
    card.feedback = {
      status: feedback.status,
      score: feedback.score,
      tag: feedback.tag1,
      txHash: feedback.tx_hash
    };
  }
  if (['failed', 'payment-uncertain', 'needs-input'].includes(row.state)) {
    card.error = failureMessage(row.failure_code);
    if (row.state === 'needs-input') card.inputSchema = row.service_snapshot?.inputSchema;
  }
  return card;
}
