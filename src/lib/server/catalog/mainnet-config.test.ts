import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { mapStellar8004Metadata } from './stellar8004';
import { configuredServiceProfiles } from '$lib/server/network/policy';

/**
 * The mainnet route table lives in wrangler.jsonc as a JSON document escaped
 * inside a JSON string. A typo there parses as valid config right up until a
 * user asks for work and the router is nowhere in the catalogue, so the shipped
 * value is exercised here rather than trusted.
 */
function mainnetVars(): Record<string, string> {
  const source = readFileSync(new URL('../../../../wrangler.jsonc', import.meta.url), 'utf8');
  const stripped = source
    .split('\n')
    .map((line) => (/^\s*\/\//.test(line) ? '' : line))
    .join('\n');
  return JSON.parse(stripped).env.mainnet.vars;
}

// Agent 67 as it is registered on mainnet: one x402 service pointing at a free
// catalogue, plus a REST health endpoint. Neither charges for anything.
const registration = {
  type: 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1',
  name: 'ROZO MPP Router',
  description: 'Pay upstream API services with Stellar USDC.',
  x402: true,
  services: [
    { name: 'x402', endpoint: 'https://apiserver.mpprouter.dev/v1/services/catalog', version: '1.0' },
    { name: 'rest', endpoint: 'https://apiserver.mpprouter.dev/health' }
  ]
};

describe('shipped mainnet configuration', () => {
  it('allowlists the identities the route table configures', () => {
    const vars = mainnetVars();
    const allowed = new Set(vars.ALGORIA_ALLOWED_AGENT_IDS.split(',').map((id) => id.trim()));
    for (const key of configuredServiceProfiles(vars.ALGORIA_SERVICE_PROFILES).keys()) {
      expect(allowed).toContain(key.split(':')[0]);
    }
  });

  it('turns the router registration into routes that can actually be paid', () => {
    const profiles = configuredServiceProfiles(mainnetVars().ALGORIA_SERVICE_PROFILES);
    const resources = mapStellar8004Metadata(67, registration, profiles);
    expect(resources.map((resource) => resource.serviceName).sort()).toEqual(['exa-search', 'firecrawl-scrape']);
    for (const route of resources) {
      expect(route.executionStatus).toBe('ready');
      expect(route.endpoint.startsWith('https://apiserver.mpprouter.dev/v1/services/')).toBe(true);
      // The router answers 402 before it validates, so the probe can reject
      // nothing: an absent example would be paid for before being read.
      expect(route.inputExample).toBeTruthy();
    }
  });

  // The endpoints the registration itself declares sell nothing: one is a price
  // list, the other a health check. Both answer 200 to the work they describe.
  it('offers nothing that answers 200 without doing the work', () => {
    const profiles = configuredServiceProfiles(mainnetVars().ALGORIA_SERVICE_PROFILES);
    const endpoints = mapStellar8004Metadata(67, registration, profiles).map((resource) => resource.endpoint);
    expect(endpoints).not.toContain('https://apiserver.mpprouter.dev/v1/services/catalog');
    expect(endpoints).not.toContain('https://apiserver.mpprouter.dev/health');
  });
});
