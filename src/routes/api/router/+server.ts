import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { ACTIVE_NETWORK_LABEL } from '$lib/constants';
import { conversationalReply } from '$lib/server/routing/intent';
import { getStellar8004Agent } from '$lib/server/catalog/stellar8004';
import { configuredAllowedAgentIds, assertLeanV0Selection } from '$lib/server/network/policy';
import { rerankResources } from '$lib/server/openrouter';
import { cached } from '$lib/server/catalog/cache';
import { readBoundedJsonObject } from '$lib/server/security/body';

export const POST: RequestHandler = async ({ request, locals }) => {
  const body = await readBoundedJsonObject(request);
  if (typeof body.prompt !== 'string' || body.prompt.trim().length < 2 || body.prompt.length > 4_000) {
    return json({ message: 'Prompt must contain 2-4000 characters' }, { status: 400 });
  }
  const prompt = body.prompt.trim();
  const reply = conversationalReply(prompt);
  if (reply) return json({ kind: 'conversation', query: prompt, message: reply });

  const agentIds = [...configuredAllowedAgentIds()];
  if (agentIds.length > 0) {
    const key = `lean-router:${agentIds.join(',')}`;
    const settled = await cached(key, 60_000, () => Promise.allSettled(agentIds.map(getStellar8004Agent)));
    const partial = settled.some((result) => result.status === 'rejected');
    const executable = settled
      .flatMap((result) => result.status === 'fulfilled' ? result.value : [])
      .filter((resource) => {
        try {
          assertLeanV0Selection(resource, new Set(agentIds));
          return resource.executionStatus === 'ready';
        } catch {
          return false;
        }
      });
    // Routing stays open to an anonymous visitor, because seeing what Algoria
    // would do is the whole landing experience. The model call does not: it spends
    // the operator's OpenRouter balance on a caller-supplied prompt, and this is
    // the only unauthenticated route that could reach it. Signed-out callers get
    // the deterministic local ranking instead.
    const resources = await rerankResources(prompt, executable, Boolean(locals.auth));
    if (resources.length > 0) {
      return json({
        kind: 'agent-route',
        query: prompt,
        resources,
        partial,
        warnings: partial ? ['One or more allowlisted Stellar 8004 identities could not be resolved.'] : [],
        sources: [{ source: 'stellar8004', ok: resources.length > 0, latencyMs: 0 }]
      });
    }
  }

  return json({
    kind: 'no-match',
    query: prompt,
    message: agentIds.length === 0
      ? `Algoria is running on ${ACTIVE_NETWORK_LABEL}. The controlled 8004 service catalog is not configured yet, so no external service was called.`
      : 'No executable service was found in the allowlisted Stellar 8004 identities. No external service was called.'
  });
};
