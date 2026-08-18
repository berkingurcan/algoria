import type { CatalogResource, CatalogSearchResponse } from '$lib/types/catalog';
import { endpointKey } from '$lib/utils/url';
import { cached } from './cache';
import { searchBazaar } from './bazaar';
import { searchStellar8004 } from './stellar8004';
import { safeErrorMessage } from '$lib/server/shared/sanitize';
import { assertLeanV0Feature } from '$lib/server/network/policy';

export function mergeResources(registry: CatalogResource[], bazaar: CatalogResource[]): CatalogResource[] {
  const byEndpoint = new Map<string, CatalogResource>();
  const withoutEndpoint: CatalogResource[] = [];
  for (const resource of registry) {
    if (!resource.endpoint) {
      withoutEndpoint.push(resource);
      continue;
    }
    byEndpoint.set(endpointKey(resource.endpoint), resource);
  }
  const unmatchedBazaar: CatalogResource[] = [];
  for (const resource of bazaar) {
    const key = endpointKey(resource.endpoint);
    const match = byEndpoint.get(key);
    if (!match) {
      unmatchedBazaar.push(resource);
      continue;
    }
    byEndpoint.set(key, {
      ...match,
      protocols: [...new Set([...match.protocols, ...resource.protocols])],
      inputSchema: resource.inputSchema ?? match.inputSchema,
      inputExample: resource.inputExample ?? match.inputExample,
      pricing: resource.pricing ?? match.pricing,
      executionStatus: resource.executionStatus,
      updatedAt: resource.updatedAt ?? match.updatedAt,
      rawSourceIds: [...new Set([...match.rawSourceIds, ...resource.rawSourceIds])]
    });
  }
  return [...byEndpoint.values(), ...unmatchedBazaar, ...withoutEndpoint];
}

export function stellarNativeExecutableResources(resources: CatalogResource[]): CatalogResource[] {
  return resources.filter((resource) => resource.agent8004Id !== undefined && resource.executionStatus === 'ready');
}

function relevance(resource: CatalogResource, query: string): number {
  const terms = query.toLowerCase().split(/\s+/).filter((term) => term.length > 1);
  const haystack = `${resource.name} ${resource.description} ${resource.serviceName ?? ''}`.toLowerCase();
  const text = terms.reduce((score, term) => score + (haystack.includes(term) ? 1 : 0), 0);
  const ready = resource.executionStatus === 'ready' ? 1 : 0;
  const identity = resource.agent8004Id !== undefined ? 0.35 : 0;
  const evidence = Math.min((resource.evidence.feedbackCount ?? resource.evidence.qualityCalls30d ?? 0) / 100, 0.25);
  return text * 10 + ready + identity + evidence;
}

export async function searchCatalog(query: string): Promise<CatalogSearchResponse> {
  assertLeanV0Feature('openCatalogDiscovery');
  const normalized = query.trim().slice(0, 400);
  return cached(`catalog:${normalized.toLowerCase()}`, 60_000, async () => {
    const started = Date.now();
    const [stellar, bazaar] = await Promise.allSettled([
      searchStellar8004(normalized, 8),
      searchBazaar(normalized, 20)
    ]);
    const stellarLatency = Date.now() - started;
    const sources: CatalogSearchResponse['sources'] = [];
    const warnings: string[] = [];

    if (stellar.status === 'fulfilled') sources.push({ source: 'stellar8004', ok: true, latencyMs: stellarLatency });
    else {
      const error = safeErrorMessage(stellar.reason);
      sources.push({ source: 'stellar8004', ok: false, latencyMs: stellarLatency, error });
      warnings.push(`Stellar 8004 discovery is partial: ${error}`);
    }
    if (bazaar.status === 'fulfilled') sources.push({ source: 'x402-bazaar', ok: true, latencyMs: Date.now() - started });
    else {
      const error = safeErrorMessage(bazaar.reason);
      sources.push({ source: 'x402-bazaar', ok: false, latencyMs: Date.now() - started, error });
      warnings.push(`x402 Bazaar discovery is partial: ${error}`);
    }

    const registry = stellar.status === 'fulfilled' ? stellar.value.resources : [];
    const paid = bazaar.status === 'fulfilled' ? bazaar.value.resources : [];
    const resources = mergeResources(registry, paid).sort((a, b) => relevance(b, normalized) - relevance(a, normalized));
    return {
      query: normalized,
      resources,
      partial: stellar.status === 'rejected' || bazaar.status === 'rejected' ||
        (stellar.status === 'fulfilled' && stellar.value.partial) ||
        (bazaar.status === 'fulfilled' && bazaar.value.partial),
      warnings,
      sources
    };
  });
}
