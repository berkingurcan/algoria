import { describe, expect, it } from 'vitest';
import { endpointKey, normalizeEndpoint } from './url';

describe('catalog endpoint normalization', () => {
  it('deduplicates case, default ports, fragments, and trailing slashes', () => {
    expect(normalizeEndpoint('https://EXAMPLE.com:443/task/#fragment')).toBe('https://example.com/task');
    expect(endpointKey('https://example.com/task/')).toBe(endpointKey('https://EXAMPLE.com/task'));
  });
});
