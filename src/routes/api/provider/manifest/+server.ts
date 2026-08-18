import { env } from '$env/dynamic/private';
import { env as publicEnv } from '$env/dynamic/public';
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { providerConfig } from '$lib/server/provider/config';
import { providerProtocolManifest } from '$lib/server/provider/metadata';
import { safeErrorMessage } from '$lib/server/shared/sanitize';

export const GET: RequestHandler = async ({ url }) => {
  try {
    const config = providerConfig();
    const rawAgentId = env.ALGORIA_PROVIDER_AGENT_ID;
    const agentId = rawAgentId?.trim() ? Number(rawAgentId) : undefined;
    if (agentId !== undefined && (!Number.isSafeInteger(agentId) || agentId < 0)) {
      throw new Error('ALGORIA_PROVIDER_AGENT_ID must be a non-negative integer');
    }
    const origin = publicEnv.PUBLIC_APP_ORIGIN || url.origin;
    return json(providerProtocolManifest(origin, config.payTo, agentId), {
      headers: { 'cache-control': 'public, max-age=60' }
    });
  } catch (error) {
    return json({ code: 'provider-unavailable', message: safeErrorMessage(error) }, {
      status: 503,
      headers: { 'cache-control': 'no-store' }
    });
  }
};
