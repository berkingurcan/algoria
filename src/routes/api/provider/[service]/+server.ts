import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { handleProviderRequest } from '$lib/server/provider/handler';
import { safeErrorMessage } from '$lib/server/shared/sanitize';

export const POST: RequestHandler = async ({ request, params }) => {
  try {
    return await handleProviderRequest(request, params.service);
  } catch (error) {
    return json({ code: 'provider-unavailable', message: safeErrorMessage(error) }, {
      status: 503,
      headers: { 'cache-control': 'no-store' }
    });
  }
};
