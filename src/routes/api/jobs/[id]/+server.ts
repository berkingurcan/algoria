import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireAuth } from '$lib/server/auth/require';
import { getFeedbackAction, getOwnedJob, getPayment } from '$lib/server/db/jobs';
import { jobCardFromRow } from '$lib/server/db/job-card';

export const GET: RequestHandler = async (event) => {
  const { auth } = requireAuth(event);
  const job = await getOwnedJob(auth.userId, event.params.id);
  if (!job) return json({ message: 'Job not found' }, { status: 404 });
  const payment = await getPayment(job.id);
  const feedback = await getFeedbackAction(job.id).catch(() => null);
  return json({ job: jobCardFromRow(job, payment, feedback) });
};
