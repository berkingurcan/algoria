import { describe, expect, it } from 'vitest';
import { readBoundedJsonObject } from './body';

describe('bounded JSON request bodies', () => {
  it('parses a bounded JSON object', async () => {
    const request = new Request('https://algoria.test/api', { method: 'POST', body: '{"prompt":"hello"}' });
    await expect(readBoundedJsonObject(request, 64)).resolves.toEqual({ prompt: 'hello' });
  });

  it('rejects declared and streamed bodies over the limit', async () => {
    const declared = new Request('https://algoria.test/api', {
      method: 'POST', headers: { 'content-length': '1000' }, body: '{}'
    });
    await expect(readBoundedJsonObject(declared, 16)).rejects.toThrow(/exceeds/);

    const streamed = new Request('https://algoria.test/api', { method: 'POST', body: '{"text":"too large"}' });
    await expect(readBoundedJsonObject(streamed, 8)).rejects.toThrow(/exceeds/);
  });
});
