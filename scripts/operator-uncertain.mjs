#!/usr/bin/env node
/**
 * Operator sweep for uncertain payment outcomes.
 *
 * Lists every Job in `payment-uncertain`, plus Jobs stuck in `executing` for
 * more than 10 minutes, and re-drives the one allowed recovery mechanism per
 * Job: a same-origin, token-authenticated provider status lookup. It never
 * resubmits a payment credential.
 *
 * Read-only by default. With --apply it writes only evidence-backed outcomes:
 * a recovered success needs a settled Payment Receipt, a recovered failure a
 * recorded terminal settlement state. Anything else stays visibly uncertain.
 *
 *   pnpm ops:uncertain
 *   pnpm ops:uncertain -- --apply
 *
 * Requires PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY (read from .env).
 */
import { createClient } from '@supabase/supabase-js';

const STUCK_EXECUTING_MS = 10 * 60_000;
const apply = process.argv.includes('--apply');

const url = process.env.PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SECRET_KEY;
if (!url || !key) {
  console.error('PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY are required (via .env or the environment).');
  process.exit(1);
}
const admin = createClient(url, key, { auth: { persistSession: false } });

function record(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : {};
}

/** Mirrors the server's recoverSnapshot rules so the bearer token cannot leak off-origin. */
function recoveryTarget(snapshot) {
  const { correlationId, recoveryToken, recoveryUrl, url: requestUrl } = record(snapshot);
  if (!recoveryUrl || !requestUrl) return null;
  if (!/^[A-Za-z0-9_-]{43}$/.test(recoveryToken ?? '')) return null;
  try {
    const target = new URL(recoveryUrl);
    const origin = new URL(requestUrl);
    if (target.protocol !== 'https:' && target.hostname !== '127.0.0.1') return null;
    if (target.origin !== origin.origin || target.search || target.hash) return null;
    if (target.pathname !== `/api/provider/status/${correlationId}`) return null;
    return { url: target.toString(), token: recoveryToken, correlationId };
  } catch {
    return null;
  }
}

/** succeeded without a settled Payment Receipt is downgraded to uncertain. */
async function lookupStatus(target) {
  const response = await fetch(target.url, {
    headers: { Accept: 'application/json', 'X-Algoria-Recovery-Token': target.token },
    signal: AbortSignal.timeout(15_000)
  });
  let body = {};
  try { body = record(await response.json()); } catch { /* bounded below */ }
  const status = ['succeeded', 'processing', 'uncertain', 'failed'].includes(String(body.status)) ? body.status : null;
  const receipt = record(body.paymentReceipt);
  const settlementReference = typeof receipt.settlementReference === 'string' ? receipt.settlementReference : undefined;
  if (!status) return { kind: response.status === 404 ? 'not-found' : 'unreadable', http: response.status };
  return {
    kind: status === 'succeeded' && !settlementReference ? 'uncertain' : status,
    http: response.status,
    settlementReference,
    body
  };
}

async function updatePersistedCard(job, patch) {
  const { data: row } = await admin.from('messages').select('id,content')
    .eq('conversation_id', job.conversation_id).eq('kind', 'job')
    .eq('content->job->>id', job.id).limit(1).maybeSingle();
  if (!row?.content?.job) return;
  await admin.from('messages').update({ content: { job: { ...row.content.job, payment: undefined, ...patch } } }).eq('id', row.id);
}

async function applyOutcome(job, payment, outcome) {
  if (outcome.kind === 'succeeded') {
    if (payment) {
      await admin.from('payment_records')
        .update({ status: 'settled', tx_hash: outcome.settlementReference })
        .eq('id', payment.id).in('status', ['signed', 'reconciling']);
    }
    await admin.from('jobs')
      .update({ state: 'succeeded', failure_code: null, result_content: outcome.body })
      .eq('id', job.id).in('state', ['executing', 'payment-uncertain']);
    await updatePersistedCard(job, {
      state: 'succeeded', error: undefined,
      result: { status: 0, body: outcome.body, txHash: outcome.settlementReference }
    });
    await admin.from('audit_events').insert({
      user_id: job.user_id, event_type: 'payment.recover', target_type: 'job', target_id: job.id, outcome: 'succeeded-operator'
    });
    return 'applied: succeeded';
  }
  if (outcome.kind === 'failed') {
    if (payment) {
      await admin.from('payment_records').update({ status: 'failed' })
        .eq('id', payment.id).in('status', ['signed', 'reconciling']);
    }
    await admin.from('jobs')
      .update({ state: 'failed', failure_code: 'provider_settlement_failed', result_content: outcome.body })
      .eq('id', job.id).in('state', ['executing', 'payment-uncertain']);
    await updatePersistedCard(job, {
      state: 'failed',
      error: 'The provider recorded a terminal settlement failure; no second payment should be submitted.'
    });
    await admin.from('audit_events').insert({
      user_id: job.user_id, event_type: 'payment.recover', target_type: 'job', target_id: job.id, outcome: 'failed-operator'
    });
    return 'applied: failed';
  }
  if (job.state === 'executing' && payment && ['signed', 'reconciling'].includes(payment.status)) {
    // A claimed payment with no verifiable outcome must be visibly uncertain, not silently executing.
    if (payment.status === 'signed') {
      await admin.from('payment_records').update({ status: 'reconciling' }).eq('id', payment.id).eq('status', 'signed');
    }
    await admin.from('jobs')
      .update({ state: 'payment-uncertain', failure_code: 'payment_outcome_uncertain' })
      .eq('id', job.id).in('state', ['executing']);
    await updatePersistedCard(job, {
      state: 'payment-uncertain',
      error: 'Payment outcome is uncertain. Do not pay again; use Check status to re-verify.'
    });
    return 'applied: marked payment-uncertain';
  }
  return 'no evidence-backed outcome; left unchanged';
}

const HORIZON_URL = process.env.STELLAR_HORIZON_URL || 'https://horizon-testnet.stellar.org';
const USDC_SAC = process.env.STELLAR_USDC_SAC || 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA';

function atomic(amount) {
  const [whole, fraction = ''] = String(amount).split('.');
  return `${whole}${fraction.padEnd(7, '0')}`.replace(/^0+(?=\d)/, '');
}

/**
 * Re-derives a claimed settlement from the ledger, mirroring the server rule:
 * the transaction must have succeeded and carry the approved transfer.
 */
async function ledgerConfirms(txHash, expectedAmountAtomic, expectedPayTo) {
  if (!/^[0-9a-f]{64}$/i.test(txHash ?? '')) return { ok: false, reason: 'malformed transaction hash' };
  const { Asset } = await import('@stellar/stellar-sdk');
  const passphrase = process.env.STELLAR_NETWORK_PASSPHRASE || 'Test SDF Network ; September 2015';
  try {
    const transaction = await (await fetch(`${HORIZON_URL}/transactions/${txHash.toLowerCase()}`)).json();
    if (transaction?.status === 404 || transaction?.successful !== true) {
      return { ok: false, reason: transaction?.successful === false ? 'transaction failed on the ledger' : 'not found on the ledger' };
    }
    const operations = await (await fetch(`${HORIZON_URL}/transactions/${txHash.toLowerCase()}/operations`)).json();
    const changes = (operations?._embedded?.records ?? []).flatMap((operation) => operation.asset_balance_changes ?? []);
    const match = changes.some((change) => {
      if (change.type !== 'transfer' || change.to !== expectedPayTo) return false;
      if (atomic(change.amount) !== String(expectedAmountAtomic)) return false;
      try {
        return new Asset(change.asset_code, change.asset_issuer).contractId(passphrase) === USDC_SAC;
      } catch {
        return false;
      }
    });
    return match
      ? { ok: true, ledger: transaction.ledger }
      : { ok: false, reason: 'the approved transfer is not in this transaction' };
  } catch (cause) {
    return { ok: false, reason: `ledger lookup failed (${cause instanceof Error ? cause.message : cause})` };
  }
}

/** Payments whose receipt never verified on-chain, independent of the job's own state. */
async function sweepUnverifiedReceipts() {
  const { data, error } = await admin.from('payment_records')
    .select('id,job_id,amount_atomic,pay_to,tx_hash,status,created_at')
    .eq('network', NETWORK)
    .eq('status', 'reconciling')
    .not('tx_hash', 'is', null)
    .order('created_at', { ascending: true });
  if (error) {
    console.error(`Receipt query failed: ${error.message}`);
    return 0;
  }
  if (!data.length) return 0;
  console.log(`\nUnverified receipts: ${data.length} payment(s) claiming settlement that never matched the ledger\n`);
  let stillUnverified = 0;
  for (const payment of data) {
    const verdict = await ledgerConfirms(payment.tx_hash, payment.amount_atomic, payment.pay_to);
    const head = `payment ${payment.id} · job ${payment.job_id} · tx ${String(payment.tx_hash).slice(0, 12)}…`;
    if (verdict.ok) {
      console.log(`${head}\n  ledger confirms the approved transfer (ledger ${verdict.ledger})`);
      if (apply) {
        await admin.from('payment_records').update({ status: 'settled' }).eq('id', payment.id).eq('status', 'reconciling');
        console.log('  applied: settled');
      }
    } else {
      stillUnverified += 1;
      console.log(`${head}\n  NOT confirmed: ${verdict.reason}. Do not treat this as a paid receipt`);
    }
    console.log('');
  }
  return stillUnverified;
}

// One database can hold more than one network's records, and an agent id is only
// unique within its own registry, so the sweep only ever touches its own network.
const NETWORK = process.env.STELLAR_NETWORK || 'stellar:testnet';
const stuckBefore = new Date(Date.now() - STUCK_EXECUTING_MS).toISOString();
const columns = 'id,user_id,conversation_id,state,created_at,request_content';
const [uncertainResult, stuckResult] = await Promise.all([
  admin.from('jobs').select(columns).eq('network', NETWORK).eq('state', 'payment-uncertain'),
  admin.from('jobs').select(columns).eq('network', NETWORK).eq('state', 'executing').lt('created_at', stuckBefore)
]);
const queryError = uncertainResult.error ?? stuckResult.error;
if (queryError) {
  console.error(`Query failed: ${queryError.message}`);
  process.exit(1);
}
const jobs = [...(uncertainResult.data ?? []), ...(stuckResult.data ?? [])]
  .sort((a, b) => a.created_at.localeCompare(b.created_at));

console.log(`Operator sweep · ${NETWORK} · ${jobs.length} candidate job(s)${apply ? ' (apply mode)' : ' (read-only; use --apply to write verified outcomes)'}\n`);
let unresolved = 0;
for (const job of jobs) {
  const { data: payment } = await admin.from('payment_records').select('*').eq('job_id', job.id).maybeSingle();
  const head = `${job.id} · ${job.state} · payment ${payment?.status ?? 'none'} · created ${job.created_at}`;
  const target = recoveryTarget(record(job.request_content).snapshot);
  if (!target) {
    unresolved += 1;
    console.log(`${head}\n  no usable recovery target (snapshot missing or retained-out); manual review required\n`);
    continue;
  }
  let outcome;
  try {
    outcome = await lookupStatus(target);
  } catch (cause) {
    unresolved += 1;
    console.log(`${head}\n  status lookup failed (${cause instanceof Error ? cause.message : cause}); retry later\n`);
    continue;
  }
  const evidence = outcome.settlementReference ? ` · tx ${outcome.settlementReference}` : '';
  console.log(`${head}\n  correlation ${target.correlationId} → provider says ${outcome.kind} (HTTP ${outcome.http})${evidence}`);
  if (apply) {
    const applied = await applyOutcome(job, payment, outcome);
    console.log(`  ${applied}\n`);
    if (applied.startsWith('no evidence')) unresolved += 1;
  } else {
    if (!['succeeded', 'failed'].includes(outcome.kind)) unresolved += 1;
    console.log('');
  }
}
const unverifiedReceipts = await sweepUnverifiedReceipts();

console.log(unresolved
  ? `${unresolved} job(s) remain unresolved. No payment should be resubmitted for them.`
  : 'No unresolved uncertain payments.');
if (unverifiedReceipts) {
  console.log(`${unverifiedReceipts} receipt(s) still unconfirmed on the ledger. Treat those as unpaid until proven.`);
}
