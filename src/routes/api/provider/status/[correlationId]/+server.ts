import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { providerRunStore } from '$lib/server/provider/store';
import { canRecoverProviderRun, providerStatusResponse, validProviderCorrelationId } from '$lib/server/provider/handler';
import { safeErrorMessage } from '$lib/server/shared/sanitize';

export const GET: RequestHandler = async ({ params, request }) => {
  if (!validProviderCorrelationId(params.correlationId)) {
    return json({ code: 'invalid-correlation' }, { status: 400, headers: { 'cache-control': 'no-store' } });
  }
  try {
    const run = await providerRunStore.get(params.correlationId);
    const recoveryToken = request.headers.get('x-algoria-recovery-token') ?? '';
    if (!run || !canRecoverProviderRun(run, recoveryToken)) {
      return json({ code: 'not-found' }, { status: 404, headers: { 'cache-control': 'no-store' } });
    }
    return providerStatusResponse(run);
  } catch (error) {
    return json({ code: 'provider-store-unavailable', message: safeErrorMessage(error) }, {
      status: 503,
      headers: { 'cache-control': 'no-store' }
    });
  }
};
