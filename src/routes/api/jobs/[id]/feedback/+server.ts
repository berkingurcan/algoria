import { json } from '@sveltejs/kit';
import { TransactionBuilder, rpc } from '@stellar/stellar-sdk';
import type { RequestHandler } from './$types';
import { ACTIVE_NETWORK_PASSPHRASE, LEAN_V0_NETWORK } from '$lib/constants';
import { requireAuth } from '$lib/server/auth/require';
import { jobCardFromRow } from '$lib/server/db/job-card';
import {
  audit, getFeedbackAction, getOwnedJob, getPayment, updateFeedbackAction, updatePersistedJobMessage,
  upsertFeedbackAction, type JobRow
} from '$lib/server/db/jobs';
import { assertLeanV0Feature, policyFailure } from '$lib/server/network/policy';
import { readBoundedJsonObject } from '$lib/server/security/body';
import { safeErrorMessage } from '$lib/server/shared/sanitize';
import {
  buildFeedbackTransaction, isFeedbackScore, verify8004FeedbackTransaction, type ExpectedFeedback
} from '$lib/server/feedback/stellar';

const MAX_TAG = 32;

function tag(value: unknown, required: boolean): string | undefined {
  if (value === undefined || value === null || value === '') {
    if (required) throw new Error('A one-word tag is required');
    return undefined;
  }
  const text = String(value).trim();
  if (!text || text.length > MAX_TAG) throw new Error(`A tag must be 1 to ${MAX_TAG} characters`);
  return text;
}

/**
 * Reputation is written by the client who paid, about the job they paid for.
 * Both halves are enforced here rather than trusted from the request: the Job
 * has to belong to this wallet, to have succeeded, and to have a settled
 * payment behind it. An entry backed by nothing is exactly the noise a
 * reputation registry exists to keep out.
 */
type Ratable =
  | { ok: false; response: Response }
  | { ok: true; auth: { userId: string; walletAddress: string }; job: JobRow; agentId: number };

async function ratableJob(event: Parameters<RequestHandler>[0]): Promise<Ratable> {
  const { auth } = requireAuth(event);
  const job = await getOwnedJob(auth.userId, event.params.id);
  const refuse = (message: string, status: number) => ({ ok: false as const, response: json({ message }, { status }) });
  if (!job) return refuse('Job not found', 404);
  if (job.state !== 'succeeded') return refuse('Only a completed job can be rated', 409);
  if (typeof job.agent_8004_id !== 'number') return refuse('This job did not run against a registered agent', 409);
  const payment = await getPayment(job.id);
  if (payment?.status !== 'settled') return refuse('Only a settled payment can back a reputation entry', 409);
  return { ok: true, auth, job, agentId: job.agent_8004_id };
}

export const POST: RequestHandler = async (event) => {
  try {
    assertLeanV0Feature('feedback');
    const ratable = await ratableJob(event);
    if (!ratable.ok) return ratable.response;
    const { auth, job, agentId } = ratable;

    const body = await readBoundedJsonObject(event.request);
    if (!isFeedbackScore(body.score)) {
      return json({ message: 'A score must be one of 20, 40, 60, 80 or 100' }, { status: 400 });
    }
    const tag1 = tag(body.tag1, true) as string;
    const tag2 = tag(body.tag2, false);

    const action = await upsertFeedbackAction({
      userId: auth.userId, jobId: job.id, agentId, score: body.score, tag1, tag2
    });
    if (action.status !== 'prepared') {
      return json({ message: 'This job already carries a reputation entry', feedback: { status: action.status, txHash: action.tx_hash } }, { status: 409 });
    }

    const expected: ExpectedFeedback = {
      walletAddress: auth.walletAddress, agentId, score: body.score, tag1, tag2,
      endpoint: job.endpoint, feedbackId: action.id
    };
    const transaction = await buildFeedbackTransaction(expected);
    await audit(auth.userId, 'feedback.prepare', 'job', job.id, 'prepared').catch(() => undefined);
    return json({
      feedbackId: action.id,
      transaction,
      networkPassphrase: ACTIVE_NETWORK_PASSPHRASE,
      review: { agentId, score: body.score, tag1, tag2, endpoint: job.endpoint }
    });
  } catch (error) {
    const failure = policyFailure(error);
    if (failure) return json(failure.body, { status: failure.status });
    return json({ message: safeErrorMessage(error, 'The reputation entry could not be prepared') }, { status: 400 });
  }
};

export const PUT: RequestHandler = async (event) => {
  try {
    assertLeanV0Feature('feedback');
    const ratable = await ratableJob(event);
    if (!ratable.ok) return ratable.response;
    const { auth, job, agentId } = ratable;

    const action = await getFeedbackAction(job.id);
    if (!action) return json({ message: 'Prepare the reputation entry before submitting it' }, { status: 409 });
    if (action.status === 'confirmed') {
      return json({ feedback: { status: action.status, txHash: action.tx_hash } });
    }

    const body = await readBoundedJsonObject(event.request);
    // What the wallet returns is checked against what the user approved, never
    // trusted for arriving on the same session.
    verify8004FeedbackTransaction(body.transaction, {
      walletAddress: auth.walletAddress, agentId, score: action.score,
      tag1: action.tag1, tag2: action.tag2 ?? undefined,
      endpoint: job.endpoint, feedbackId: action.id
    });

    const server = new rpc.Server(LEAN_V0_NETWORK.rpcUrl);
    const signed = TransactionBuilder.fromXDR(String(body.transaction), ACTIVE_NETWORK_PASSPHRASE);
    const sent = await server.sendTransaction(signed);
    if (sent.status === 'ERROR' || sent.status === 'DUPLICATE') {
      await updateFeedbackAction(action.id, { status: 'failed' }).catch(() => undefined);
      await audit(auth.userId, 'feedback.submit', 'job', job.id, sent.status.toLowerCase()).catch(() => undefined);
      return json({ message: 'The network refused the reputation entry' }, { status: 502 });
    }
    await updateFeedbackAction(action.id, { status: 'submitted', tx_hash: sent.hash });

    // The entry is only reputation once the ledger has it; until then it is a
    // submission, and the interface is told which of the two it is holding.
    let confirmed = false;
    for (let attempt = 0; attempt < 10 && !confirmed; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      const result = await server.getTransaction(sent.hash).catch(() => null);
      if (result?.status === 'SUCCESS') confirmed = true;
      else if (result?.status === 'FAILED') {
        await updateFeedbackAction(action.id, { status: 'failed' });
        await audit(auth.userId, 'feedback.submit', 'job', job.id, 'failed').catch(() => undefined);
        return json({ message: 'The reputation entry failed on the ledger' }, { status: 502 });
      }
    }
    if (confirmed) await updateFeedbackAction(action.id, { status: 'confirmed' });
    await audit(auth.userId, 'feedback.submit', 'job', job.id, confirmed ? 'confirmed' : 'submitted').catch(() => undefined);
    // The stored conversation message is what a reload reads, so an entry that
    // is not written back there leaves the rating control offering a second one
    // the table would refuse.
    const fresh = await getFeedbackAction(job.id).catch(() => null);
    await updatePersistedJobMessage(job.conversation_id, jobCardFromRow(job, await getPayment(job.id), fresh))
      .catch(() => undefined);
    return json({ feedback: { status: confirmed ? 'confirmed' : 'submitted', txHash: sent.hash } });
  } catch (error) {
    const failure = policyFailure(error);
    if (failure) return json(failure.body, { status: failure.status });
    return json({ message: safeErrorMessage(error, 'The reputation entry could not be submitted') }, { status: 400 });
  }
};
