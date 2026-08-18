#!/usr/bin/env node
/**
 * Algoria testnet smoke / canary.
 *
 * Read-only by default: verifies the deployed worker's health, feature gates,
 * SEP-1 pinning, provider manifest exactness, the unpaid x402 challenge shape,
 * and recovery-status anti-enumeration. Nothing is signed and nothing is paid.
 *
 * With --paid and ALGORIA_SMOKE_WALLET_SECRET (a funded S-key for the target
 * network, holding USDC), it also drives the full product path once:
 * wallet -> prompt -> quote -> sign -> artifact + receipt. This spends real
 * value on pubnet, so give it a --prompt the deployment's allowlist can serve.
 *
 *   pnpm smoke
 *   pnpm smoke -- --origin http://127.0.0.1:8787
 *   ALGORIA_SMOKE_WALLET_SECRET=S... pnpm smoke -- --paid
 *   ... --paid --prompt "Scrape https://example.com" --network stellar:pubnet
 */
import { randomBytes, randomUUID } from 'node:crypto';

const DEFAULT_ORIGIN = 'https://algoria-testnet.yamancandev.workers.dev';
const PROFILES = {
  'stellar:testnet': {
    passphrase: 'Test SDF Network ; September 2015',
    other: 'Public Global Stellar Network ; September 2015',
    usdcSac: 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA',
    rpcUrl: 'https://soroban-testnet.stellar.org'
  },
  'stellar:pubnet': {
    passphrase: 'Public Global Stellar Network ; September 2015',
    other: 'Test SDF Network ; September 2015',
    usdcSac: 'CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75',
    rpcUrl: 'https://mainnet.sorobanrpc.com'
  }
};
// The sanity bound the canary refuses to cross, per network. The server holds
// the real cap; this is the second pair of eyes on a quote before it is signed.
const MAX_PAYMENT_ATOMIC = { 'stellar:testnet': 10_000_000n, 'stellar:pubnet': 1_000_000n };
const EXPECTED_FEATURES = {
  httpExecution: true,
  x402Payment: true,
  openCatalogDiscovery: false,
  bazaarRouting: false,
  mcpExecution: false,
  mppPayment: false,
  a2aExecution: false,
  feedback: true,
  // A policy switch, not a fact about this deployment: it says the codebase is
  // permitted to run on pubnet, and it reads the same on both deployments. What
  // network a deployment actually serves is asserted separately, from `network`
  // and `environment`, which is the claim worth checking.
  mainnet: true
};

const args = process.argv.slice(2);
const origin = (args[args.indexOf('--origin') + 1] && args.includes('--origin')
  ? args[args.indexOf('--origin') + 1]
  : DEFAULT_ORIGIN).replace(/\/$/, '');
const paid = args.includes('--paid');
// The prompt has to suit the deployment's allowlist: asking a scraper to
// summarize routes to the wrong service or to none at all.
const promptArg = args.includes('--prompt') ? args[args.indexOf('--prompt') + 1] : undefined;
const networkArg = args.includes('--network') ? args[args.indexOf('--network') + 1] : undefined;
const NETWORK = networkArg ?? process.env.PUBLIC_STELLAR_NETWORK ?? 'stellar:testnet';
if (!PROFILES[NETWORK]) {
  console.error(`Unknown network "${NETWORK}"; expected stellar:testnet or stellar:pubnet.`);
  process.exit(1);
}
const { passphrase: TESTNET_PASSPHRASE, other: PUBNET_PASSPHRASE, usdcSac: TESTNET_USDC_SAC, rpcUrl: TESTNET_RPC_URL } = PROFILES[NETWORK];
const TESTNET_CAIP2 = NETWORK;

let failures = 0;
function pass(stage, detail = '') {
  console.log(`  ✓ ${stage}${detail ? `: ${detail}` : ''}`);
}
function fail(stage, detail) {
  failures += 1;
  console.error(`  ✗ ${stage}: ${detail}`);
}
function assert(condition, stage, detail, okDetail = '') {
  if (condition) pass(stage, okDetail);
  else fail(stage, detail);
  return Boolean(condition);
}

async function getJson(response) {
  try { return await response.json(); } catch { return null; }
}

function decodeAccepts(headerValue) {
  for (const candidate of [
    () => JSON.parse(Buffer.from(headerValue, 'base64').toString('utf8')),
    () => JSON.parse(headerValue)
  ]) {
    try {
      const decoded = candidate();
      if (decoded && Array.isArray(decoded.accepts)) return decoded;
    } catch { /* try the next encoding */ }
  }
  return null;
}

async function checkHealth() {
  const response = await fetch(`${origin}/api/health`);
  const body = await getJson(response);
  if (!assert(response.ok && body?.ok === true, 'health', `status ${response.status}`)) return;
  assert(body.network === TESTNET_CAIP2, 'health network', `got ${body.network}`);
  assert(
    body.environment === (NETWORK === 'stellar:pubnet' ? 'mainnet' : 'testnet'),
    'health environment',
    `got ${body.environment}`
  );
  const drift = Object.entries(EXPECTED_FEATURES)
    .filter(([feature, expected]) => body.features?.[feature] !== expected)
    .map(([feature]) => feature);
  assert(drift.length === 0, 'feature gates', `drifted: ${drift.join(', ')}`, 'all lean v0 gates match');
  // `ok` is the only passing answer: a deploy that expects columns its database
  // lacks breaks job creation, and so does one that cannot reach a database at
  // all. Three different faults, three different fixes, so they are not
  // collapsed into one message.
  // `unconfigured` is the one that hides: `wrangler secret put` reads stdin when
  // it has no terminal, so a command run without one uploads an empty value and
  // still prints success. Nothing is rejected because nothing is ever sent.
  const SCHEMA_REMEDY = {
    drift: 'the deployed code expects columns this database does not have; apply pending migrations',
    unconfigured: 'the deployment holds no database credential. SUPABASE_SECRET_KEY is empty or unset. `wrangler secret put` accepts an empty value silently when it has no terminal; pipe the value in instead',
    unavailable: 'the credential is present but the database rejected it or could not be reached'
  };
  assert(body.schema === 'ok', 'database schema',
    SCHEMA_REMEDY[body.schema] ?? `unexpected schema status "${body.schema}"`,
    body.schema ?? 'unreported');
}

async function checkStellarToml() {
  const response = await fetch(`${origin}/.well-known/stellar.toml`);
  const text = response.ok ? await response.text() : '';
  assert(response.ok && text.includes(TESTNET_PASSPHRASE), 'stellar.toml', `status ${response.status} or missing testnet passphrase`);
  assert(!text.includes(PUBNET_PASSPHRASE), 'stellar.toml pubnet absence', 'pubnet passphrase leaked into stellar.toml');
}

async function checkManifest() {
  const response = await fetch(`${origin}/api/provider/manifest`);
  const body = await getJson(response);
  // A client-only deployment (the mainnet one) ships no controlled provider.
  if (response.status === 501 || response.status === 503) {
    console.log(`  - provider checks skipped: this deployment serves no controlled provider (HTTP ${response.status})`);
    return null;
  }
  if (!assert(response.ok && body, 'manifest', `status ${response.status}`)) return null;
  assert(body.network === TESTNET_CAIP2, 'manifest network', `got ${body.network}`);
  assert(body.asset === TESTNET_USDC_SAC, 'manifest asset', `got ${body.asset}`);
  assert(/^G[A-Z2-7]{55}$/.test(body.payTo ?? ''), 'manifest payTo', `not a G-address: ${body.payTo}`);
  const services = Array.isArray(body.services) ? body.services.map((service) => service.name) : [];
  const missing = ['summarize', 'extract', 'classify'].filter((name) => !services.includes(name));
  assert(missing.length === 0, 'manifest services', `missing: ${missing.join(', ')}`, services.join(', '));
  return body;
}

async function checkUnpaidChallenge(manifest) {
  if (!manifest) return;
  const response = await fetch(`${origin}/api/provider/summarize`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'X-Algoria-Correlation-Id': randomUUID(),
      'X-Algoria-Recovery-Token': randomBytes(32).toString('base64url')
    },
    body: JSON.stringify({ text: 'Smoke check: no payment attached, expect an exact x402 challenge.' })
  });
  if (!assert(response.status === 402, 'unpaid 402', `status ${response.status}`)) return;
  const header = response.headers.get('payment-required') ?? response.headers.get('x-payment-required');
  if (!assert(Boolean(header), 'PAYMENT-REQUIRED header', 'header missing')) return;
  const decoded = decodeAccepts(header);
  if (!assert(Boolean(decoded), 'challenge decodes', 'PAYMENT-REQUIRED is not decodable')) return;
  const option = decoded.accepts.find((item) => item.scheme === 'exact' && item.network === TESTNET_CAIP2);
  if (!assert(Boolean(option), 'exact testnet option', `accepts: ${JSON.stringify(decoded.accepts)}`)) return;
  assert(option.asset === TESTNET_USDC_SAC, 'challenge asset', `got ${option.asset}`);
  assert(BigInt(option.amount ?? option.maxAmountRequired ?? '0') <= MAX_PAYMENT_ATOMIC[NETWORK], 'challenge under cap', `amount ${option.amount}`);
  if (manifest) assert(option.payTo === manifest.payTo, 'challenge payTo matches manifest', `${option.payTo} != ${manifest.payTo}`);
}

async function checkRecoveryAntiEnumeration() {
  const response = await fetch(`${origin}/api/provider/status/${randomUUID()}`, {
    headers: { 'X-Algoria-Recovery-Token': randomBytes(32).toString('base64url') }
  });
  assert(response.status === 404, 'recovery anti-enumeration', `status ${response.status}`);
}

async function paidFlow() {
  const secret = process.env.ALGORIA_SMOKE_WALLET_SECRET;
  if (!secret) {
    fail('paid flow', 'ALGORIA_SMOKE_WALLET_SECRET is required with --paid');
    return;
  }
  console.log(`\nPaid canary. This spends real value on ${NETWORK}:`);
  const { Keypair, TransactionBuilder } = await import('@stellar/stellar-sdk');
  const { x402Client } = await import('@x402/core/client');
  const { decodePaymentRequiredHeader, encodePaymentSignatureHeader } = await import('@x402/core/http');
  const { ExactStellarScheme } = await import('@x402/stellar/exact/client');
  const { createEd25519Signer } = await import('@x402/stellar');

  const keypair = Keypair.fromSecret(secret);
  const address = keypair.publicKey();
  let cookies = '';
  const call = (path, init = {}) => fetch(`${origin}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(cookies ? { cookie: cookies } : {}), ...(init.headers ?? {}) }
  });

  // 1. Wallet: SEP-10 challenge + verify
  const challengeResponse = await call(`/api/auth/sep10/challenge?account=${encodeURIComponent(address)}`);
  const challenge = await getJson(challengeResponse);
  if (!assert(challengeResponse.ok && challenge?.networkPassphrase === TESTNET_PASSPHRASE, 'sep10 challenge', challenge?.message ?? `status ${challengeResponse.status}`)) return;
  const transaction = TransactionBuilder.fromXDR(challenge.transaction, TESTNET_PASSPHRASE);
  transaction.sign(keypair);
  const verifyResponse = await call('/api/auth/sep10/verify', { method: 'POST', body: JSON.stringify({ transaction: transaction.toXDR() }) });
  const verified = await getJson(verifyResponse);
  if (!assert(verifyResponse.ok && verified?.walletAddress === address, 'sep10 verify', verified?.message ?? `status ${verifyResponse.status}`)) return;
  cookies = verifyResponse.headers.getSetCookie().map((cookie) => cookie.split(';')[0]).join('; ');

  // 2. Prompt: route to one allowlisted service
  const prompt = promptArg ?? 'Summarize this text: Algoria runs one reviewed job at a time. Payment approval stays separate from job approval, and every paid run returns an artifact with a receipt.';
  const routerResponse = await call('/api/router', { method: 'POST', body: JSON.stringify({ prompt }) });
  const routed = await getJson(routerResponse);
  const resource = routed?.kind === 'agent-route'
    ? routed.resources.find((candidate) => candidate.executionStatus === 'ready')
    : null;
  if (!assert(Boolean(resource), 'router proposal', routed?.message ?? `kind ${routed?.kind}; check the provider/discovery/allowlist chain`)) return;
  pass('router proposal', `${resource.name} · ${resource.serviceName ?? resource.key}`);

  // 3. Prepare the exact request
  const prepareResponse = await call('/api/jobs/prepare', { method: 'POST', body: JSON.stringify({ prompt, resource }) });
  const preparation = await getJson(prepareResponse);
  if (!assert(prepareResponse.ok && preparation?.token, 'prepare snapshot', preparation?.message ?? `status ${prepareResponse.status}`)) return;

  // 4. Approve: expect an exact x402 quote
  const jobResponse = await call('/api/jobs', { method: 'POST', body: JSON.stringify({ prompt, resource, preparationToken: preparation.token }) });
  const jobBody = await getJson(jobResponse);
  const job = jobBody?.job;
  if (!assert(job?.state === 'awaiting-payment' && job?.payment?.paymentRequired, 'quote issued', jobBody?.message ?? `state ${job?.state}`)) return;
  assert(job.payment.network === TESTNET_CAIP2 && job.payment.asset === TESTNET_USDC_SAC, 'quote policy', `network ${job.payment.network} asset ${job.payment.asset}`);
  assert(BigInt(job.payment.amountAtomic) <= MAX_PAYMENT_ATOMIC[NETWORK], 'quote under cap', `amount ${job.payment.amountAtomic}`);
  pass('quote issued', `${job.payment.amountUsdc} USDC to ${job.payment.payTo.slice(0, 8)}… · expires ${job.payment.expiresAt}`);

  // 5. Sign the exact quote and settle
  const required = decodePaymentRequiredHeader(job.payment.paymentRequired);
  const signer = createEd25519Signer(secret, TESTNET_CAIP2);
  const client = new x402Client().register(TESTNET_CAIP2, new ExactStellarScheme(signer, { url: TESTNET_RPC_URL }));
  const credential = encodePaymentSignatureHeader(await client.createPaymentPayload(required));
  const paymentResponse = await call(`/api/jobs/${job.id}/payment`, { method: 'POST', body: JSON.stringify({ credential }) });
  const paymentBody = await getJson(paymentResponse);
  const settledJob = paymentBody?.job;
  if (settledJob?.state === 'payment-uncertain') {
    fail('settlement', `uncertain outcome; recovery id ${settledJob.correlationId ?? 'unknown'}. Do NOT pay again, use /api/jobs/${job.id}/recover`);
    return;
  }
  if (!assert(paymentResponse.ok && settledJob?.state === 'succeeded', 'settlement', paymentBody?.message ?? `state ${settledJob?.state}`)) return;
  assert(Boolean(settledJob.result?.txHash), 'payment receipt', 'no settlement transaction on the result', `tx ${settledJob.result?.txHash}`);
  assert(Boolean(settledJob.result?.body), 'artifact returned', 'result body missing');

  // 6. Authoritative re-read
  const refetch = await call(`/api/jobs/${job.id}`);
  const refetched = await getJson(refetch);
  assert(refetch.ok && refetched?.job?.state === 'succeeded', 'authoritative job state', `state ${refetched?.job?.state}`);
}

console.log(`Algoria smoke → ${origin} · ${NETWORK}${paid ? ' (paid canary enabled)' : ''}`);
console.log('\nRead-only checks:');
try {
  await checkHealth();
  await checkStellarToml();
  const manifest = await checkManifest();
  await checkUnpaidChallenge(manifest);
  await checkRecoveryAntiEnumeration();
  if (paid) await paidFlow();
} catch (error) {
  fail('smoke run', error instanceof Error ? error.message : String(error));
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log('\nAll checks passed.');
