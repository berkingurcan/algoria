import { describe, expect, it } from 'vitest';
import { mapStellar8004Metadata } from './stellar8004';

describe('Stellar 8004 metadata mapping', () => {
  it('maps the controlled HTTP+x402 service into a lean executable resource', () => {
    const [resource] = mapStellar8004Metadata(42, {
      type: 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1',
      name: 'Algoria Provider',
      description: 'Deterministic test provider',
      x402: true,
      services: [{
        name: 'HTTP x402 summarize',
        endpoint: 'https://provider.example/api/provider/summarize',
        description: 'Summarizes text',
        inputExample: '{"text":"Example","maxSentences":3}'
      }]
    });

    expect(resource).toMatchObject({
      agent8004Id: 42,
      endpoint: 'https://provider.example/api/provider/summarize',
      protocols: ['http', 'x402'],
      executionStatus: 'ready',
      inputExample: { text: 'Example', maxSentences: 3 }
    });
  });

  it('fails closed when the registration declares an unsupported runtime protocol', () => {
    const [resource] = mapStellar8004Metadata(7, {
      type: 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1',
      name: 'MCP only',
      services: [{ name: 'MCP', endpoint: 'https://mcp.example', inputExample: '{}' }]
    });
    expect(resource.executionStatus).toBe('unsupported-protocol');
  });
});
