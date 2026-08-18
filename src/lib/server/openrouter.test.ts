import { describe, expect, it } from 'vitest';
import { alignResourcesToRequestedNetwork, compileArguments, rerankResources, validateArguments } from './openrouter';
import type { CatalogResource } from '$lib/types/catalog';

describe('deterministic agent arguments', () => {
  it('wraps Bazaar HTTP examples and hydrates nested URL fields', async () => {
    const schema = {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object', required: ['input'],
      properties: {
        input: {
          type: 'object', required: ['type', 'method', 'body'],
          properties: {
            type: { const: 'http' }, method: { const: 'POST' },
            body: { type: 'object', required: ['url', 'target'], properties: { url: { type: 'string' }, target: { type: 'string' } } }
          }
        }
      }
    };
    const example = { type: 'http', method: 'POST', body: { url: 'https://old.example', target: 'old target' } };
    const args = await compileArguments('Scrape https://example.com/product and return its price', schema, example);
    expect(args.input).toMatchObject({
      type: 'http', method: 'POST',
      body: { url: 'https://example.com/product', target: 'Scrape https://example.com/product and return its price' }
    });
  });

  it('hydrates controlled provider text while preserving bounded defaults', async () => {
    const schema = {
      type: 'object', additionalProperties: false, required: ['text'],
      properties: { text: { type: 'string' }, maxSentences: { type: 'integer' } }
    };
    const args = await compileArguments('Summarize this exact content', schema, { text: 'replace me', maxSentences: 3 });
    expect(args).toEqual({ text: 'Summarize this exact content', maxSentences: 3 });
  });

  it('accepts the unconstrained 8004 fallback without runtime schema compilation', () => {
    const args = { text: 'Summarize this exact content', maxSentences: 3 };
    expect(validateArguments(args, { type: 'object', properties: {} })).toEqual(args);
  });
});

describe('network-aware routing', () => {
  const resource = (key: string, description: string): CatalogResource => ({
    key,
    source: 'x402-bazaar',
    name: key,
    description,
    endpoint: `https://${key}.example/api`,
    protocols: ['x402'],
    evidence: { identity: 'bazaar-only', reputationStatus: 'not-applicable', labels: [] },
    executionStatus: 'ready',
    rawSourceIds: [key]
  });

  it('does not confuse a Stellar payment rail with a Base-only subject capability', () => {
    const base = resource('base-radar', 'Ranks sellers using real Base USDC settlements.');
    const neutral = resource('web-research', 'Researches a requested ecosystem and returns cited findings.');
    const stellar = resource('stellar-research', 'Research and analytics for the Stellar ecosystem.');
    expect(alignResourcesToRequestedNetwork('Compare the Stellar x402 ecosystem', [base, neutral, stellar]).map((item) => item.key))
      .toEqual(['stellar-research', 'web-research']);
  });

  it('preserves ranking when the user does not name a network', () => {
    const first = resource('first', 'Base USDC settlement analytics.');
    const second = resource('second', 'General research.');
    expect(alignResourcesToRequestedNetwork('Research x402 sellers', [first, second]).map((item) => item.key))
      .toEqual(['first', 'second']);
  });

  it('uses capability terms for a deterministic lean fallback', async () => {
    const summarize = resource('summarize', 'Summarizes supplied text.');
    const classify = resource('classify', 'Classifies supplied text into labels.');
    expect((await rerankResources('Classify this support request', [summarize, classify])).map((item) => item.key))
      .toEqual(['classify', 'summarize']);
  });

  it('prefers an exact service capability over incidental description wording', async () => {
    const extract = {
      ...resource('provider', 'Extracts requested fields from supplied text.'),
      key: 'extract', serviceName: 'HTTP x402 extract'
    };
    const classify = {
      ...resource('provider', 'Chooses one supplied label using token overlap.'),
      key: 'classify', serviceName: 'HTTP x402 classify'
    };
    expect((await rerankResources('Classify this support request', [extract, classify]))[0].key).toBe('classify');
  });
});
