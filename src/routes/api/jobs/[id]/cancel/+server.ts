import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireAuth } from '$lib/server/auth/require';
import { audit, cancelAwaitingPaymentJob, getOwnedJob, getPayment, updateJobWhen, updatePayment, updatePersistedJobMessage } from '$lib/server/db/jobs';
import type { JobCard } from '$lib/types/chat';

/**
 * The atomic cancel RPC only covers a live `quoted` payment. An expired quote can
 * never be claimed (the claim RPC requires `quoted` and an unexpired timestamp),
 * so closing that job directly cannot race a payment.
 */
async function cancelExpiredQuoteJob(userId: string, jobId: string): Promise<boolean> {
  const job = await getOwnedJob(userId, jobId);
  if (job?.state !== 'awaiting-payment') return false;
  const payment = await getPayment(jobId);
  const expired = payment && (
    payment.status === 'expired' ||
    (payment.status === 'quoted' && new Date(payment.quote_expires_at).getTime() <= Date.now())
  );
  if (!expired) return false;
  const updated = await updateJobWhen(jobId, ['awaiting-payment'], { state: 'cancelled' });
  if (!updated) return false;
  if (payment.status === 'quoted') await updatePayment(payment.id, { status: 'expired' }).catch(() => undefined);
  return true;
}

export const POST: RequestHandler = async (event) => {
  const { auth } = requireAuth(event);
  const job = await getOwnedJob(auth.userId, event.params.id);
  if (!job) return json({ message: 'Job not found' }, { status: 404 });
  const cancelled = await cancelAwaitingPaymentJob(auth.userId, job.id)
    || await cancelExpiredQuoteJob(auth.userId, job.id);
  if (!cancelled) {
    return json({ message: 'This payment is already claimed, cancelled, or expired' }, { status: 409 });
  }
  const card: JobCard = {
    id: job.id,
    prompt: job.request_content?.prompt ?? '',
    selected: job.service_snapshot,
    arguments: job.request_content?.arguments,
    correlationId: job.request_content?.snapshot?.correlationId,
    state: 'cancelled'
  };
  await Promise.allSettled([
    updatePersistedJobMessage(job.conversation_id, card),
    audit(auth.userId, 'payment.cancel', 'job', job.id, 'cancelled')
  ]);
  return json({ job: card });
};
