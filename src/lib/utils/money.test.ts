import { describe, expect, it } from 'vitest';
import { atomicToUsdc, isWithinUsdcCap, usdcToAtomic } from './money';

describe('Stellar USDC amounts', () => {
  it('round-trips seven-decimal atomic units', () => {
    expect(atomicToUsdc('10000000')).toBe('1');
    expect(atomicToUsdc('1234567')).toBe('0.1234567');
    expect(usdcToAtomic('0.0000001')).toBe('1');
  });

  it('enforces the one USDC cap with integer math', () => {
    expect(isWithinUsdcCap('10000000', 1)).toBe(true);
    expect(isWithinUsdcCap('10000001', 1)).toBe(false);
  });

  it('rejects malformed precision', () => {
    expect(() => usdcToAtomic('1.00000001')).toThrow();
    expect(() => atomicToUsdc('-1')).toThrow();
  });
});
