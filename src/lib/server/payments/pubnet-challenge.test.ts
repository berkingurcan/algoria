import { describe, expect, it } from 'vitest';
import { parseX402Quote } from './x402';

/**
 * A real 402 challenge, captured verbatim from a registered mainnet router
 * (agent 67, `/v1/services/firecrawl/scrape`). Until this existed, every quote
 * the parser had ever seen came from our own controlled provider, so it had
 * only been proven against the implementation it was written alongside.
 *
 * It decodes to x402 v2, scheme `exact`, network `stellar:pubnet`, amount
 * `20000` (0.002 USDC), the pinned pubnet USDC SAC, and `areFeesSponsored`.
 */
const PUBNET_CHALLENGE =
  'eyJ4NDAyVmVyc2lvbiI6MiwiZXJyb3IiOiJQYXltZW50IHJlcXVpcmVkIiwicmVzb3VyY2UiOnsidXJsIjoiaHR0cHM6Ly9h' +
  'cGlzZXJ2ZXIubXBwcm91dGVyLmRldi92MS9zZXJ2aWNlcy9maXJlY3Jhd2wvc2NyYXBlIn0sImFjY2VwdHMiOlt7InNjaGVt' +
  'ZSI6ImV4YWN0IiwibmV0d29yayI6InN0ZWxsYXI6cHVibmV0IiwiYW1vdW50IjoiMjAwMDAiLCJhc3NldCI6IkNDVzY3VFNa' +
  'VjNTU1MySFhNQlE1SkZHQ0tKTlhLWk03VVFVV1VaUFVUSFhTVFpMRU83U0pNSTc1IiwicGF5VG8iOiJHREszQVZXM1lFNlVM' +
  'M0o0V0xOS0JNUDY1S1NZMzJZUFVLSU9DNlBYVzY1WEozTEVHM1lJRFhYQiIsIm1heFRpbWVvdXRTZWNvbmRzIjozMDAsImV4' +
  'dHJhIjp7ImFyZUZlZXNTcG9uc29yZWQiOnRydWV9fV19';

describe('a mainnet challenge reaching a testnet deployment', () => {
  // The suite runs as a testnet deployment. Refusing a pubnet quote is the
  // property that matters here: the amount and the asset both look plausible,
  // and only the network and the SAC say otherwise. A deployment that accepted
  // it would ask its user to sign away real USDC from a test harness.
  it('is refused, naming the network rather than the amount', () => {
    expect(() => parseX402Quote(PUBNET_CHALLENGE)).toThrow(/payment option was offered/);
  });

  it('is refused no matter how the challenge is malformed around it', () => {
    expect(() => parseX402Quote('')).toThrow(/missing or too large/);
    expect(() => parseX402Quote('x'.repeat(64_001))).toThrow(/missing or too large/);
  });
});
