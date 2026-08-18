import { describe, expect, it } from 'vitest';
import { mapStellar8004Metadata, ipfsGatewayUrl } from './stellar8004';
import { configuredServiceProfiles } from '$lib/server/network/policy';

// A registration that declares a service but no inputExample. Stellar 8004 leaves
// the field optional, so a consumer cannot assume one is present.
const registration = {
  type: 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1',
  name: 'Scrapper Agent',
  description: 'Scrapes URLs and returns structured data.',
  x402: true,
  services: [{ name: 'x402', endpoint: 'https://scrapper.example/task', version: '1.0' }]
};

describe('operator-supplied service shape', () => {
  // Requiring an optional field made every production service unroutable, so a
  // registration without one now routes and has its shape resolved at prepare.
  it('routes a real registration that declares no input, leaving the shape to preparation', () => {
    const [resource] = mapStellar8004Metadata(10, registration);
    expect(resource.executionStatus).toBe('ready');
    expect(resource.inputExample).toBeUndefined();
  });

  it('makes the same service routable once the operator supplies the shape', () => {
    const profiles = configuredServiceProfiles(JSON.stringify({
      '10': { inputExample: { url: 'https://example.com' } }
    }));
    const [resource] = mapStellar8004Metadata(10, registration, profiles);
    expect(resource.executionStatus).toBe('ready');
    expect(resource.inputExample).toEqual({ url: 'https://example.com' });
  });

  it('prefers a service-specific profile over the agent-wide one', () => {
    const profiles = configuredServiceProfiles(JSON.stringify({
      '10': { inputExample: { url: 'https://agent-wide.example' } },
      '10:x402': { inputExample: { url: 'https://service.example' }, inputSchema: { type: 'object' } }
    }));
    const [resource] = mapStellar8004Metadata(10, registration, profiles);
    expect(resource.inputExample).toEqual({ url: 'https://service.example' });
    expect(resource.inputSchema).toEqual({ type: 'object' });
  });

  it('never lets a profile promote an unsupported protocol or plain-HTTP endpoint', () => {
    const profiles = configuredServiceProfiles(JSON.stringify({ '10': { inputExample: { url: 'x' } } }));
    const [insecure] = mapStellar8004Metadata(10, {
      ...registration,
      services: [{ name: 'x402', endpoint: 'http://scrapper.example/task' }]
    }, profiles);
    expect(insecure.executionStatus).not.toBe('ready');

    const [mcp] = mapStellar8004Metadata(10, {
      ...registration,
      services: [{ name: 'mcp', endpoint: 'https://scrapper.example/task' }]
    }, profiles);
    expect(mcp.executionStatus).toBe('unsupported-protocol');
  });

  it('rejects malformed operator configuration instead of ignoring it', () => {
    expect(() => configuredServiceProfiles('not json')).toThrow(/JSON object/);
    expect(() => configuredServiceProfiles(JSON.stringify({ 'agent-10': { inputExample: {} } }))).toThrow(/agentId/);
    expect(configuredServiceProfiles(JSON.stringify({ '10': { unrelated: true } })).size).toBe(0);
    expect(configuredServiceProfiles('').size).toBe(0);
  });
});

// A router registration of the shape that actually appears on mainnet: the only
// x402 service points at a free catalogue that lists hundreds of paid routes.
const router = {
  type: 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1',
  name: 'ROZO MPP Router',
  description: 'Pay upstream API services with Stellar USDC.',
  x402: true,
  services: [
    { name: 'x402', endpoint: 'https://apiserver.mpprouter.dev/v1/services/catalog', version: '1.0' },
    { name: 'rest', endpoint: 'https://apiserver.mpprouter.dev/health' }
  ]
};

describe('operator-named routes', () => {
  // Without one, the declared endpoint answers 200 with a price list: the user
  // pays nothing and receives a catalogue instead of the work they asked for.
  it('leaves the catalogue endpoint in place when the operator names no route', () => {
    const [resource] = mapStellar8004Metadata(67, router);
    expect(resource.endpoint).toBe('https://apiserver.mpprouter.dev/v1/services/catalog');
  });

  it('narrows a declared service onto the route the operator vetted', () => {
    const profiles = configuredServiceProfiles(JSON.stringify({
      '67:x402': { endpoint: 'https://apiserver.mpprouter.dev/v1/services/firecrawl/scrape' }
    }));
    const [resource] = mapStellar8004Metadata(67, router, profiles);
    expect(resource.endpoint).toBe('https://apiserver.mpprouter.dev/v1/services/firecrawl/scrape');
    expect(resource.executionStatus).toBe('ready');
  });

  it('adds routes the registration never published, without duplicating declared ones', () => {
    const profiles = configuredServiceProfiles(JSON.stringify({
      '67:firecrawl-scrape': {
        endpoint: 'https://apiserver.mpprouter.dev/v1/services/firecrawl/scrape',
        description: 'Scrape one URL and return structured content.',
        inputExample: { url: 'https://example.com' }
      },
      '67:exa-search': { endpoint: 'https://apiserver.mpprouter.dev/v1/services/exa/search' }
    }));
    const resources = mapStellar8004Metadata(67, router, profiles);
    expect(resources).toHaveLength(4);
    const scrape = resources.find((resource) => resource.serviceName === 'firecrawl-scrape');
    expect(scrape?.endpoint).toBe('https://apiserver.mpprouter.dev/v1/services/firecrawl/scrape');
    expect(scrape?.protocols).toEqual(['http', 'x402']);
    expect(scrape?.executionStatus).toBe('ready');
    expect(scrape?.inputExample).toEqual({ url: 'https://example.com' });
    expect(scrape?.description).toBe('Scrape one URL and return structured content.');
    // The declared service keeps its own identity rather than being replaced.
    expect(resources.filter((resource) => resource.serviceName === 'x402')).toHaveLength(1);
  });

  // The on-chain identity is what vouches for a host. An operator that could
  // point a vetted agent at an unrelated origin would sever exactly that link.
  it('refuses a route on an origin the agent never published', () => {
    const profiles = configuredServiceProfiles(JSON.stringify({
      '67:x402': { endpoint: 'https://attacker.example/v1/services/firecrawl/scrape' }
    }));
    expect(() => mapStellar8004Metadata(67, router, profiles)).toThrow(/outside the origins/);

    const added = configuredServiceProfiles(JSON.stringify({
      '67:elsewhere': { endpoint: 'https://attacker.example/route' }
    }));
    expect(() => mapStellar8004Metadata(67, router, added)).toThrow(/outside the origins/);
  });

  // Naming better routes does not remove the worse ones: the catalogue answers
  // 200 and inherits a description about the very work it cannot do.
  it('withdraws the declared services the operator did not put on offer', () => {
    const profiles = configuredServiceProfiles(JSON.stringify({
      '67': { offered: false },
      '67:firecrawl-scrape': { endpoint: 'https://apiserver.mpprouter.dev/v1/services/firecrawl/scrape' }
    }));
    const resources = mapStellar8004Metadata(67, router, profiles);
    expect(resources.map((resource) => resource.serviceName)).toEqual(['firecrawl-scrape']);
  });

  it('withdraws one service without touching the rest', () => {
    const profiles = configuredServiceProfiles(JSON.stringify({ '67:rest': { offered: false } }));
    const resources = mapStellar8004Metadata(67, router, profiles);
    expect(resources.map((resource) => resource.serviceName)).toEqual(['x402']);
  });

  it('rejects an endpoint the operator cannot have meant', () => {
    // An agent-wide key would collapse every service onto one route.
    expect(() => configuredServiceProfiles(JSON.stringify({
      '67': { endpoint: 'https://apiserver.mpprouter.dev/v1/services/firecrawl/scrape' }
    }))).toThrow(/agentId>:<serviceName/);
    expect(() => configuredServiceProfiles(JSON.stringify({
      '67:x402': { endpoint: 'http://apiserver.mpprouter.dev/route' }
    }))).toThrow(/https URL/);
    expect(() => configuredServiceProfiles(JSON.stringify({
      '67:x402': { endpoint: 'not a url' }
    }))).toThrow(/https URL/);
  });
});

describe('IPFS metadata resolution', () => {
  const gateway = 'https://ipfs.example/ipfs/';
  const cid = 'bafkreib75fzfjc3c5u3xv6lemowaqyzjri3dd3nnc4qkwbj5lvircq52dq';

  it('maps a CID onto the configured gateway', () => {
    expect(ipfsGatewayUrl(`ipfs://${cid}`, gateway)).toBe(`https://ipfs.example/ipfs/${cid}`);
    expect(ipfsGatewayUrl(`ipfs://ipfs/${cid}`, 'https://ipfs.example/ipfs')).toBe(`https://ipfs.example/ipfs/${cid}`);
  });

  it('keeps a nested path under the CID', () => {
    expect(ipfsGatewayUrl(`ipfs://${cid}/agent.json`, gateway)).toBe(`https://ipfs.example/ipfs/${cid}/agent.json`);
  });

  it('refuses malformed or traversing references', () => {
    expect(ipfsGatewayUrl('ipfs://short', gateway)).toBeUndefined();
    expect(ipfsGatewayUrl(`ipfs://${cid}/../secret`, gateway)).toBeUndefined();
    expect(ipfsGatewayUrl(`ipfs://${cid}/a?x=1`, gateway)).toBeUndefined();
  });
});
