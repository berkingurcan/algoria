import { describe, expect, it } from 'vitest';
import { compileArguments, MissingInputError } from './openrouter';

// No model is configured on either deployment, so this deterministic path is
// the one that actually compiles every request a user pays for.
const SCHEMA = { type: 'object' as const };
const EXAMPLE = { url: 'https://example.com' };

describe('compiling a request from a prompt', () => {
  it('takes the target the user named, however they wrote it', async () => {
    for (const [prompt, expected] of [
      ['Scrape https://trionlabs.dev and return the content', 'https://trionlabs.dev'],
      ['scrap trionlabs.dev', 'https://trionlabs.dev'],
      ['scrape www.trionlabs.dev/about please', 'https://www.trionlabs.dev/about'],
      ['fetch http://trionlabs.dev', 'http://trionlabs.dev']
    ] as const) {
      const args = await compileArguments(prompt, SCHEMA, EXAMPLE);
      expect(args, prompt).toEqual({ url: expected });
    }
  });

  /**
   * The example's own URL used to survive into the compiled request whenever the
   * prompt named no target, so the reviewed request read example.com while the
   * user had asked for something else, and approving it paid to scrape the
   * wrong page. Asking is the only safe answer.
   */
  it('refuses to substitute the example when no target was named', async () => {
    await expect(compileArguments('scrape something for me', SCHEMA, EXAMPLE)).rejects.toThrow(MissingInputError);
    await expect(compileArguments('scrape something for me', SCHEMA, EXAMPLE)).rejects.toMatchObject({
      fields: ['url']
    });
  });

  it('does not read an ordinary sentence as a target', async () => {
    const args = await compileArguments('summarize this text', SCHEMA, { query: 'placeholder' });
    expect(args).toEqual({ query: 'summarize this text' });
  });
});
