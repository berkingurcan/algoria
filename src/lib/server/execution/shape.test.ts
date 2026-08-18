import { describe, expect, it } from 'vitest';
import { candidateShapes, probeRejectsShape } from './shape';

describe('request shape candidates', () => {
  it('tries a JSON body first, then the same scalars as query parameters', () => {
    const candidates = candidateShapes({ url: 'https://example.com' });
    expect(candidates[0]).toEqual({ url: 'https://example.com' });
    expect(candidates[1]).toEqual({
      type: 'http',
      method: 'GET',
      queryParams: { url: 'https://example.com' }
    });
  });

  it('keeps only scalars in the query candidate, since a URL cannot carry objects', () => {
    const [, query] = candidateShapes({ url: 'https://example.com', options: { depth: 2 }, limit: 5 });
    expect(query).toEqual({
      type: 'http',
      method: 'GET',
      queryParams: { url: 'https://example.com', limit: 5 }
    });
  });

  it('offers no query candidate when nothing can be expressed in a query string', () => {
    expect(candidateShapes({ options: { depth: 2 } })).toHaveLength(1);
  });

  it('leaves an operator-authored shape alone, since it already states method and placement', () => {
    const explicit = { type: 'http', method: 'GET', queryParams: { url: 'https://example.com' } };
    expect(candidateShapes(explicit)).toEqual([explicit]);
  });

  // A probe can reject a shape, never confirm one: services that charge before
  // validating answer 402 to anything, including an empty body.
  it('treats a client error as a rejection but 402 as no evidence', () => {
    expect(probeRejectsShape(400)).toBe(true);
    expect(probeRejectsShape(422)).toBe(true);
    expect(probeRejectsShape(404)).toBe(true);
    expect(probeRejectsShape(402)).toBe(false);
    expect(probeRejectsShape(200)).toBe(false);
    expect(probeRejectsShape(500)).toBe(false);
  });
});
