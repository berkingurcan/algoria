import { describe, expect, it } from 'vitest';
import { parseProviderInput, providerRequestHash, runProviderService } from './services';

describe('controlled provider services', () => {
  it('summarizes deterministically and bounds requested work', () => {
    const input = parseProviderInput('summarize', { text: 'One. Two! Three?', maxSentences: 2 });
    expect(runProviderService('summarize', input)).toEqual({
      kind: 'summary', summary: 'One. Two!', sentences: ['One.', 'Two!']
    });
    expect(() => parseProviderInput('summarize', { text: 'One.', maxSentences: 6 })).toThrow(/1 to 5/);
  });

  it('extracts only explicitly requested labeled fields', () => {
    const input = parseProviderInput('extract', {
      text: 'Title: Testnet proof\nCompany: Algoria', fields: ['title', 'company', 'date']
    });
    expect(runProviderService('extract', input)).toEqual({
      kind: 'extraction', values: { title: 'Testnet proof', company: 'Algoria', date: null }
    });
  });

  it('classifies by stable token overlap and hashes canonical parsed input', () => {
    const input = parseProviderInput('classify', { text: 'I need invoice support', labels: ['sales', 'invoice support'] });
    expect(runProviderService('classify', input)).toMatchObject({ kind: 'classification', label: 'invoice support' });
    expect(providerRequestHash('classify', input)).toMatch(/^[a-f0-9]{64}$/);
    expect(providerRequestHash('classify', input)).toBe(providerRequestHash('classify', input));
  });
});
