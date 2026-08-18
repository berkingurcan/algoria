import { createHash, timingSafeEqual } from 'node:crypto';
import { encodePaymentResponseHeader } from '@x402/core/http';
import { atomicToUsdc } from '$lib/utils/money';
import { LEAN_V0_NETWORK } from '$lib/constants';
import { readBoundedJsonObject } from '$lib/server/security/body';
import { providerTestMode } from './config';
import {
  isProviderServiceName,
  parseProviderInput,
  providerRequestHash,
  ProviderInputError,
  runProviderService,
  type ProviderServiceName
} from './services';
import { providerRunStore, type ProviderRun, type ProviderRunStore } from './store';
import {
  getProviderPaymentServer,
  providerHttpContext,
  responseFromInstructions,
  type ProviderPaymentServer
} from './x402';

const CORRELATION_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RECOVERY_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

type ProviderHandlerDependencies = {
  paymentServer?: ProviderPaymentServer;
  store?: ProviderRunStore;
  testMode?: 'response-loss' | null;
};

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers }
  });
}

function runResponse(run: ProviderRun): Response {
  const headers = { 'x-algoria-correlation-id': run.correlation_id };
  if (run.status === 'succeeded') {
    return jsonResponse({
      correlationId: run.correlation_id,
      service: run.service,
      status: run.status,
      artifact: run.artifact,
      paymentReceipt: run.payment_receipt
    }, 200, { ...headers, 'payment-response': run.payment_response ?? '' });
  }
  if (run.status === 'processing' || run.status === 'uncertain') {
    return jsonResponse({
      correlationId: run.correlation_id,
      service: run.service,
      status: run.status,
      message: run.status === 'uncertain'
        ? 'Settlement outcome is uncertain; check this status endpoint before attempting another payment.'
        : 'The paid request is still processing.'
    }, 202, headers);
  }
  return jsonResponse({
    correlationId: run.correlation_id,
    service: run.service,
    status: run.status,
    code: run.failure_code ?? 'provider-failed'
  }, 409, headers);
}

function settlementOutcomeIsUncertain(settlement: { errorReason?: string; errorMessage?: string; transaction?: string }): boolean {
  if (settlement.transaction) return true;
  const detail = `${settlement.errorReason ?? ''} ${settlement.errorMessage ?? ''}`.toLowerCase();
  return /(timeout|timed out|try_again_later|temporar|unavailable|network|submission_failed|unexpected_settle_error)/.test(detail);
}

export function providerRecoveryTokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function canRecoverProviderRun(run: ProviderRun, token: string): boolean {
  if (!RECOVERY_TOKEN_PATTERN.test(token)) return false;
  const actual = Buffer.from(providerRecoveryTokenHash(token), 'hex');
  const expected = Buffer.from(run.recovery_token_hash, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

async function persistSuccessfulRun(
  store: ProviderRunStore,
  correlationId: string,
  artifact: Record<string, unknown>,
  receipt: Record<string, unknown>,
  paymentResponse: string
): Promise<ProviderRun> {
  try {
    return await store.succeed(correlationId, artifact, receipt, paymentResponse);
  } catch {
    // Retrying this database-only write cannot settle or execute the work again.
    return store.succeed(correlationId, artifact, receipt, paymentResponse);
  }
}

/**
 * This route takes no session, so it used to be the one place a caller could make
 * the worker buffer and parse a body of any size before a single payment check
 * had run. It now shares the same transport bound as every other JSON endpoint.
 *
 * Deliberately the shared default rather than a tighter number of its own: the
 * published input schema allows 12,000 characters of text, which JSON escaping
 * can carry past 70 KB, so any bound chosen to feel "small enough" would reject
 * requests this service's own manifest advertises as valid. The transport bound
 * exists to stop unbounded buffering; the real input bound is the schema, checked
 * immediately below by `parseProviderInput`.
 */
async function parsedJson(request: Request): Promise<unknown> {
  const contentType = request.headers.get('content-type') ?? '';
  if (!contentType.toLowerCase().startsWith('application/json')) throw new ProviderInputError('Content-Type must be application/json');
  try {
    return await readBoundedJsonObject(request);
  } catch (error) {
    throw new ProviderInputError(
      error instanceof Error && /exceeds/.test(error.message)
        ? 'Request body is too large'
        : 'Request body must be a JSON object'
    );
  }
}

export async function handleProviderRequest(
  request: Request,
  serviceValue: string,
  dependencies: ProviderHandlerDependencies = {}
): Promise<Response> {
  if (request.method !== 'POST') return jsonResponse({ code: 'method-not-allowed' }, 405, { allow: 'POST' });
  if (!isProviderServiceName(serviceValue)) return jsonResponse({ code: 'service-not-found' }, 404);
  const service: ProviderServiceName = serviceValue;
  const correlationId = request.headers.get('x-algoria-correlation-id') ?? '';
  if (!CORRELATION_PATTERN.test(correlationId)) {
    return jsonResponse({ code: 'invalid-correlation', message: 'X-Algoria-Correlation-Id must be a UUID' }, 400);
  }
  const recoveryToken = request.headers.get('x-algoria-recovery-token') ?? '';
  if (!RECOVERY_TOKEN_PATTERN.test(recoveryToken)) {
    return jsonResponse({ code: 'invalid-recovery-token', message: 'X-Algoria-Recovery-Token is required' }, 400, {
      'x-algoria-correlation-id': correlationId
    });
  }
  const recoveryTokenHash = providerRecoveryTokenHash(recoveryToken);

  let input;
  try {
    input = parseProviderInput(service, await parsedJson(request));
  } catch (error) {
    return jsonResponse({ code: 'invalid-input', message: error instanceof Error ? error.message : 'Invalid input' }, 400, {
      'x-algoria-correlation-id': correlationId
    });
  }

  const store = dependencies.store ?? providerRunStore;
  const requestHash = providerRequestHash(service, input);
  const existing = await store.get(correlationId);
  if (existing) {
    if (!canRecoverProviderRun(existing, recoveryToken)) {
      return jsonResponse({ code: 'not-found' }, 404, { 'x-algoria-correlation-id': correlationId });
    }
    if (existing.service !== service || existing.request_hash !== requestHash) {
      return jsonResponse({ code: 'correlation-conflict', message: 'The correlation id is already bound to different work' }, 409, {
        'x-algoria-correlation-id': correlationId
      });
    }
    return runResponse(existing);
  }

  const paymentServer = dependencies.paymentServer ?? await getProviderPaymentServer();
  const context = providerHttpContext(request, input);
  const payment = await paymentServer.processHTTPRequest(context, {
    testnet: LEAN_V0_NETWORK.environment === 'testnet',
    appName: 'Algoria reference provider'
  });
  if (payment.type === 'payment-error') {
    return responseFromInstructions(payment.response, {
      'cache-control': 'no-store',
      'x-algoria-correlation-id': correlationId
    });
  }
  if (payment.type !== 'payment-verified') {
    return jsonResponse({ code: 'payment-policy-error', message: 'The provider route is not payment protected' }, 500, {
      'x-algoria-correlation-id': correlationId
    });
  }

  let claimed;
  try {
    claimed = await store.claim(correlationId, service, requestHash, recoveryTokenHash);
  } catch {
    await payment.cancellationDispatcher.cancel({ reason: 'handler_threw' }).catch(() => undefined);
    return jsonResponse({ code: 'provider-store-unavailable', message: 'The provider could not safely begin this paid request' }, 503, {
      'x-algoria-correlation-id': correlationId
    });
  }
  if (!claimed.claimed) {
    if (!canRecoverProviderRun(claimed.run, recoveryToken) || claimed.run.service !== service || claimed.run.request_hash !== requestHash) {
      await payment.cancellationDispatcher.cancel({ reason: 'after_verify_aborted' }).catch(() => undefined);
      return jsonResponse({ code: 'correlation-conflict' }, 409, { 'x-algoria-correlation-id': correlationId });
    }
    await payment.cancellationDispatcher.cancel({ reason: 'after_verify_aborted' }).catch(() => undefined);
    return runResponse(claimed.run);
  }

  let artifact: Record<string, unknown>;
  try {
    artifact = runProviderService(service, input);
  } catch {
    await payment.cancellationDispatcher.cancel({ reason: 'handler_threw' }).catch(() => undefined);
    const failed = await store.fail(correlationId, 'handler-failed');
    return runResponse(failed);
  }

  let settlement;
  try {
    settlement = await paymentServer.processSettlement(
      payment.paymentPayload,
      payment.paymentRequirements,
      payment.declaredExtensions,
      { request: context, responseBody: Buffer.from(JSON.stringify(artifact)) },
      undefined,
      payment.beforeHandlerSettlement
    );
  } catch {
    const uncertain = await store.fail(correlationId, 'settlement-outcome-uncertain', true);
    return runResponse(uncertain);
  }

  if (!settlement.success) {
    const uncertain = settlementOutcomeIsUncertain(settlement);
    const failed = await store.fail(correlationId, `settlement:${settlement.errorReason || 'failed'}`, uncertain);
    if (uncertain) return runResponse(failed);
    return responseFromInstructions(settlement.response, {
      'cache-control': 'no-store',
      'x-algoria-correlation-id': correlationId
    });
  }

  const paymentResponse = Object.entries(settlement.headers)
    .find(([name]) => name.toLowerCase() === 'payment-response')?.[1]
    ?? encodePaymentResponseHeader({
      success: true,
      transaction: settlement.transaction,
      network: settlement.network,
      amount: settlement.amount,
      payer: settlement.payer
    });
  const receipt = {
    protocol: 'x402',
    network: settlement.network,
    asset: payment.paymentRequirements.asset,
    amountAtomic: settlement.amount ?? payment.paymentRequirements.amount,
    amountUsdc: atomicToUsdc(settlement.amount ?? payment.paymentRequirements.amount),
    payTo: payment.paymentRequirements.payTo,
    payer: settlement.payer,
    settlementReference: settlement.transaction,
    correlationId,
    settledAt: new Date().toISOString()
  };
  const completed = await persistSuccessfulRun(store, correlationId, artifact, receipt, paymentResponse);
  const testMode = dependencies.testMode === undefined ? providerTestMode(request) : dependencies.testMode;
  if (testMode === 'response-loss') {
    return jsonResponse({
      code: 'simulated-response-loss',
      correlationId,
      message: 'The response was deliberately withheld after settlement; recover it from the status endpoint.'
    }, 503, { 'x-algoria-correlation-id': correlationId });
  }
  return runResponse(completed);
}

export function providerStatusResponse(run: ProviderRun): Response {
  return runResponse(run);
}

export function validProviderCorrelationId(value: string): boolean {
  return CORRELATION_PATTERN.test(value);
}
