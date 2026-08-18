import { USDC_DECIMALS } from '$lib/constants';

export function atomicToUsdc(amount: string): string {
  if (!/^\d+$/.test(amount)) throw new Error('Invalid atomic amount');
  const padded = amount.padStart(USDC_DECIMALS + 1, '0');
  const whole = padded.slice(0, -USDC_DECIMALS);
  const fraction = padded.slice(-USDC_DECIMALS).replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole;
}

export function usdcToAtomic(amount: string | number): string {
  const raw = String(amount).trim();
  if (!/^\d+(\.\d{1,7})?$/.test(raw)) throw new Error('Invalid USDC amount');
  const [whole, fraction = ''] = raw.split('.');
  return `${whole}${fraction.padEnd(USDC_DECIMALS, '0')}`.replace(/^0+(?=\d)/, '');
}

export function isWithinUsdcCap(amountAtomic: string, capUsdc: number): boolean {
  return BigInt(amountAtomic) <= BigInt(usdcToAtomic(capUsdc));
}
