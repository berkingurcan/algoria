import type { CatalogResource } from '$lib/types/catalog';
import { endpointKey } from '$lib/utils/url';
import { getStellar8004Agent } from './stellar8004';
import { UnsupportedPolicyError } from '$lib/server/network/policy';

/** Resolve a client selection against live discovery data before any egress. */
export async function resolveCatalogResource(selection: unknown): Promise<CatalogResource> {
  if (typeof selection !== 'object' || selection === null) throw new Error('A catalog resource is required');
  const candidate = selection as Partial<CatalogResource>;
  if (!candidate.endpoint || !candidate.key || !candidate.source) throw new Error('The selected catalog resource is incomplete');
  const selectedEndpoint = candidate.endpoint;

  if (candidate.source === 'stellar8004') {
    if (!Number.isInteger(candidate.agent8004Id) || (candidate.agent8004Id ?? -1) < 0) {
      throw new Error('The selected resource has no valid Stellar 8004 identity');
    }
    const services = await getStellar8004Agent(candidate.agent8004Id as number);
    const registry = services.find((item) => endpointKey(item.endpoint) === endpointKey(selectedEndpoint));
    if (!registry) throw new Error('The selected service is no longer published by this Stellar 8004 agent');
    return registry;
  }

  if (candidate.source === 'x402-bazaar') {
    throw new UnsupportedPolicyError('bazaarRouting', 'Public Bazaar routing is outside lean v0');
  }
  throw new Error('Unsupported catalog source');
}
