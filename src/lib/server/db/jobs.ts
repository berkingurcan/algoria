import { createHash } from 'node:crypto';
import { LEAN_V0_NETWORK } from '$lib/constants';
import type { CatalogResource } from '$lib/types/catalog';
import type { JobCard, JobState } from '$lib/types/chat';
import type { RequestSnapshot } from '$lib/server/execution/http';
import { getAdminClient, isDatabaseConfigured } from './client';

export type PaymentRow = {
  id: string;
  job_id: string;
  protocol: 'x402' | 'mpp';
  network: string;
  asset: string;
  /** numeric(40,0) in Postgres; PostgREST serializes it as a JSON number */
  amount_atomic: string | number;
  pay_to: string;
  quote_hash: string;
  status: 'quoted' | 'signed' | 'reconciling' | 'settled' | 'failed' | 'expired';
  quote_expires_at: string;
  expires_at: string;
  tx_hash: string | null;
};

export type JobRow = {
  id: string;
  user_id: string;
  conversation_id: string;
  state: JobState;
  protocol: string | null;
  endpoint: string;
  request_content: { prompt: string; snapshot?: RequestSnapshot; paymentRequired?: string; mppChallenge?: string; arguments?: Record<string, unknown> } | null;
  service_snapshot: CatalogResource;
  result_content: unknown;
  agent_8004_id: number | null;
  failure_code: string | null;
  created_at: string;
  network: string;
};

function digest(value: unknown) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export async function insertJob(
  userId: string,
  conversationId: string,
  resource: CatalogResource,
  protocol: string,
  prompt: string,
  preparationId: string
) {
  const admin = getAdminClient();
  const { data, error } = await admin.from('jobs').insert({
    user_id: userId,
    preparation_id: preparationId,
    conversation_id: conversationId,
    catalog_source: resource.source,
    external_resource_key: resource.key,
    agent_8004_id: resource.agent8004Id,
    endpoint: resource.endpoint,
    protocol,
    service_snapshot: resource,
    request_hash: digest({ prompt, resource: resource.key }),
    request_content: { prompt },
    network: LEAN_V0_NETWORK.caip2,
    state: 'probing'
  }).select('*').single();
  if (error?.code === '23505') throw new Error('This prepared request was already used');
  if (error) throw error;
  return data as JobRow;
}

export async function updateJob(jobId: string, values: Record<string, unknown>) {
  const { data, error } = await getAdminClient().from('jobs').update(values).eq('id', jobId).select('*').single();
  if (error) throw error;
  return data as JobRow;
}

export async function updateJobWhen(jobId: string, fromStates: JobState[], values: Record<string, unknown>) {
  const { data, error } = await getAdminClient().from('jobs').update(values)
    .eq('id', jobId).in('state', fromStates).select('*').maybeSingle();
  if (error) throw error;
  return data as JobRow | null;
}

/**
 * Deploying code that writes a column the database does not have breaks job
 * creation for everyone, and the failure only shows up when a user tries to run
 * something. This probes the columns the running code depends on so a mismatch
 * is visible before it costs anyone a request. `unavailable` is distinct from
 * `drift`: a database outage must never be reported as a schema problem.
 */
export async function schemaStatus(): Promise<'ok' | 'drift' | 'unavailable' | 'unconfigured'> {
  // Separate from `unavailable` because the remedies share nothing. `wrangler
  // secret put` reads stdin when it has no terminal, so a command run without
  // one uploads an empty value and still reports success, and the deployment then
  // holds a credential that is present in the dashboard and blank in the
  // worker. It makes no request at all, so the database logs stay silent and
  // there is no rejection anywhere to find. Saying so directly is the whole
  // difference between reading a config value and hunting an outage.
  if (!isDatabaseConfigured()) return 'unconfigured';
  const { error } = await getAdminClient().from('jobs').select('id,network,failure_code').limit(1);
  if (!error) return 'ok';
  // PostgREST reports an unknown column as 42703 (undefined_column) or PGRST204.
  return error.code === '42703' || error.code === 'PGRST204' ? 'drift' : 'unavailable';
}

export async function getOwnedJob(userId: string, jobId: string) {
  const { data, error } = await getAdminClient().from('jobs').select('*').eq('id', jobId).eq('user_id', userId).maybeSingle();
  if (error) throw error;
  return data as JobRow | null;
}

export async function insertPayment(userId: string, jobId: string, protocol: 'x402' | 'mpp', option: {
  network: string; asset: string; amountAtomic: string; payTo: string;
}, hash: string, expiresAt: string) {
  const { data, error } = await getAdminClient().from('payment_records').insert({
    user_id: userId, job_id: jobId, protocol, network: option.network, asset: option.asset,
    amount_atomic: option.amountAtomic, pay_to: option.payTo, quote_hash: hash, status: 'quoted', quote_expires_at: expiresAt
  }).select('*').single();
  if (error) throw error;
  return data as PaymentRow;
}

export async function getPayment(jobId: string) {
  const { data, error } = await getAdminClient().from('payment_records').select('*').eq('job_id', jobId).maybeSingle();
  if (error) throw error;
  return data as PaymentRow | null;
}

export async function updatePayment(id: string, values: Record<string, unknown>) {
  const { error } = await getAdminClient().from('payment_records').update(values).eq('id', id);
  if (error) throw error;
}

/**
 * Settlement transactions this wallet has already had recorded, so a ledger
 * scan cannot attribute one of them to a second job. Every call to a given
 * service costs the same, so two jobs produce transfers the ledger cannot tell
 * apart; without this the newer receipt would be claimed twice, and the unique
 * index on tx_hash would reject the write after the job had been called
 * settled.
 */
export async function claimedTxHashes(userId: string): Promise<string[]> {
  const { data, error } = await getAdminClient().from('payment_records')
    .select('tx_hash')
    .eq('user_id', userId)
    .eq('network', LEAN_V0_NETWORK.caip2)
    .not('tx_hash', 'is', null);
  if (error) throw error;
  return (data ?? []).map((row) => String((row as { tx_hash: string }).tx_hash));
}

/**
 * Atomic units already committed by this wallet inside the window. Counts every
 * payment that left the browser, signed, reconciling or settled, so an
 * unresolved outcome still consumes the budget it might have spent.
 */
export async function committedSpendAtomic(userId: string, sinceIso: string): Promise<bigint> {
  const { data, error } = await getAdminClient().from('payment_records')
    .select('amount_atomic')
    .eq('user_id', userId)
    // Scoped to the deployment's own network: testnet play must never consume a
    // mainnet budget, or the reverse, even when both share one database.
    .eq('network', LEAN_V0_NETWORK.caip2)
    .in('status', ['signed', 'reconciling', 'settled'])
    .gte('created_at', sinceIso);
  if (error) throw error;
  return (data ?? []).reduce((total, row) => total + BigInt(String((row as { amount_atomic: string | number }).amount_atomic)), 0n);
}

export async function claimPayment(id: string, signatureHash: string) {
  const { data, error } = await getAdminClient().rpc('algoria_claim_payment', {
    p_payment_id: id,
    p_signature_hash: signatureHash
  });
  if (error || !data) throw new Error('This payment quote was already used, cancelled, or expired');
}

export async function cancelAwaitingPaymentJob(userId: string, jobId: string) {
  const { data, error } = await getAdminClient().rpc('algoria_cancel_payment_job', {
    p_job_id: jobId,
    p_user_id: userId
  });
  if (error) throw error;
  return data === true;
}

async function findPersistedJobMessage(conversationId: string, jobId: string) {
  const admin = getAdminClient();
  const { data, error } = await admin.from('messages').select('id,content')
    .eq('conversation_id', conversationId).eq('kind', 'job')
    .eq('content->job->>id', jobId)
    .order('created_at', { ascending: false }).limit(1).maybeSingle();
  if (error) throw error;
  return data as { id: string; content: { job: JobCard } } | null;
}

export async function updatePersistedJobMessage(conversationId: string, job: JobCard) {
  const row = await findPersistedJobMessage(conversationId, job.id);
  if (row) await getAdminClient().from('messages').update({ content: { job } }).eq('id', row.id);
}

export async function updatePersistedFeedback(conversationId: string, jobId: string, feedback: NonNullable<JobCard['feedback']>) {
  const row = await findPersistedJobMessage(conversationId, jobId);
  if (!row) return;
  await getAdminClient().from('messages').update({ content: { job: { ...row.content.job, feedback } } }).eq('id', row.id);
}

export async function audit(userId: string, type: string, targetType: string, targetId: string, outcome: string) {
  await getAdminClient().from('audit_events').insert({ user_id: userId, event_type: type, target_type: targetType, target_id: targetId, outcome });
}

export async function prepareFeedback(userId: string, jobId: string, agentId: number, score: number, tag: string) {
  const { data, error } = await getAdminClient().from('feedback_actions').insert({
    user_id: userId, job_id: jobId, agent_8004_id: agentId, score, tag1: tag, status: 'prepared'
  }).select('id').single();
  if (error) throw error;
  return data.id as string;
}

export async function confirmFeedback(userId: string, id: string, txHash: string) {
  const { data, error } = await getAdminClient().from('feedback_actions')
    .update({ status: 'confirmed', tx_hash: txHash })
    .eq('id', id).eq('user_id', userId).eq('status', 'prepared')
    .select('job_id,score,tag1').maybeSingle();
  if (error) throw error;
  return data as { job_id: string; score: number; tag1: string } | null;
}

export async function getPreparedFeedback(userId: string, id: string) {
  const { data, error } = await getAdminClient().from('feedback_actions')
    .select('id,job_id,agent_8004_id,score,tag1')
    .eq('id', id).eq('user_id', userId).eq('status', 'prepared')
    .maybeSingle();
  if (error) throw error;
  return data as { id: string; job_id: string; agent_8004_id: number; score: number; tag1: string } | null;
}

export interface FeedbackRow {
  id: string;
  user_id: string;
  job_id: string;
  agent_8004_id: number;
  score: number;
  tag1: string;
  tag2: string | null;
  tx_hash: string | null;
  status: 'prepared' | 'submitted' | 'confirmed' | 'failed';
}

/**
 * One reputation entry per job, enforced by the table rather than by a check
 * here: a client who could rate the same job twice could inflate an agent
 * without paying twice, which is the whole reason the registry counts unique
 * clients. Re-preparing an entry that was never signed returns the existing row
 * so a reload does not strand it.
 */
export async function upsertFeedbackAction(input: {
  userId: string; jobId: string; agentId: number; score: number; tag1: string; tag2?: string;
}): Promise<FeedbackRow> {
  const existing = await getFeedbackAction(input.jobId);
  if (existing) {
    if (existing.status !== 'prepared') return existing;
    const { data, error } = await getAdminClient().from('feedback_actions')
      .update({ score: input.score, tag1: input.tag1, tag2: input.tag2 ?? null })
      .eq('id', existing.id).select('*').single();
    if (error) throw error;
    return data as FeedbackRow;
  }
  const { data, error } = await getAdminClient().from('feedback_actions').insert({
    user_id: input.userId, job_id: input.jobId, agent_8004_id: input.agentId,
    score: input.score, tag1: input.tag1, tag2: input.tag2 ?? null, status: 'prepared'
  }).select('*').single();
  if (error) throw error;
  return data as FeedbackRow;
}

export async function getFeedbackAction(jobId: string): Promise<FeedbackRow | null> {
  const { data, error } = await getAdminClient().from('feedback_actions')
    .select('*').eq('job_id', jobId).maybeSingle();
  if (error) throw error;
  return (data as FeedbackRow | null) ?? null;
}

export async function updateFeedbackAction(id: string, values: Record<string, unknown>) {
  const { error } = await getAdminClient().from('feedback_actions').update(values).eq('id', id);
  if (error) throw error;
}
