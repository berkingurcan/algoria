import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * A deployment that moves real USDC once described itself as a test network in
 * every surface a user reads: the header, the sidebar, the composer hint, the
 * match reason, and, worst, the payment approval line, which offered to spend
 * "testnet USDC" while quoting a real amount. The network name had been written
 * into the markup back when only one network existed, and no test noticed that
 * a second one had arrived.
 *
 * So the name is derived from the active profile now, and this refuses to let
 * it be written down again. `constants.ts` is where the names legitimately
 * live; everything else asks it.
 */
const NETWORK_NAMES = [/Stellar testnet/i, /Stellar mainnet/i, /testnet USDC/i, /mainnet USDC/i];

// Where a network name is data rather than a sentence: the profile table itself,
// the SDK-pinning check that must name both networks to compare them, and the
// scripts and tests that assert against a specific one.
const ALLOWED = new Set(['src/lib/constants.ts']);

function sourceFiles(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      sourceFiles(path, found);
    } else if (/\.(svelte|ts)$/.test(entry) && !/\.test\.ts$/.test(entry)) {
      found.push(path);
    }
  }
  return found;
}

describe('network naming', () => {
  it('never writes a network name into a surface a user reads', () => {
    const offenders: string[] = [];
    for (const path of sourceFiles('src')) {
      if (ALLOWED.has(path)) continue;
      const source = readFileSync(path, 'utf8');
      for (const pattern of NETWORK_NAMES) {
        const match = source.match(pattern);
        if (match) offenders.push(`${path}: ${match[0]}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
