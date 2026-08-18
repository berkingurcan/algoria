import { createHash } from 'node:crypto';
import { decodePaymentRequiredHeader, decodePaymentResponseHeader, decodePaymentSignatureHeader } from '@x402/core/http';
import type { PaymentPayload, PaymentRequired, PaymentRequirements } from '@x402/core/types';
import { ACTIVE_NETWORK_LABEL, LEAN_V0_NETWORK } from '$lib/constants';
import { assertLeanV0Configuration } from '$lib/server/network/policy';
import type { StellarPaymentOption } from '$lib/types/catalog';
import { atomicToUsdc, isWithinUsdcCap } from '$lib/utils/money';

function isClassicAddress(value: string) {
  return /^G[A-Z2-7]{55}$/.test(value);
}

export function validateRequirement(requirement: PaymentRequirements): StellarPaymentOption {
  const { maxPaymentUsdc: cap } = assertLeanV0Configuration();
  if (requirement.scheme !== 'exact') throw new Error('Only exact payments are supported');
  if (requirement.network !== LEAN_V0_NETWORK.caip2) throw new Error(`Only ${ACTIVE_NETWORK_LABEL} payments are supported`);
  if (requirement.asset !== LEAN_V0_NETWORK.usdcSac) throw new Error(`Only the ${ACTIVE_NETWORK_LABEL} USDC asset is supported`);
  if (!/^\d+$/.test(requirement.amount)) throw new Error('The payment amount is invalid');
  if (!isClassicAddress(requirement.payTo)) throw new Error('The payment recipient is invalid');
  if (!isWithinUsdcCap(requirement.amount, cap)) throw new Error(`Payment exceeds the ${cap} USDC safety cap`);
  return {
    scheme: requirement.scheme,
    network: requirement.network,
    asset: requirement.asset,
    amountAtomic: requirement.amount,
    amountUsdc: atomicToUsdc(requirement.amount),
    payTo: requirement.payTo,
    maxTimeoutSeconds: requirement.maxTimeoutSeconds
  };
}

export function parseX402Quote(header: string): { required: PaymentRequired; requirement: PaymentRequirements; option: StellarPaymentOption } {
  if (!header || header.length > 64_000) throw new Error('The x402 payment challenge is missing or too large');
  const required = decodePaymentRequiredHeader(header);
  if (required.x402Version !== 2) throw new Error('Only x402 v2 is supported');
  const requirement = required.accepts.find((item) =>
    item.scheme === 'exact' && item.network === LEAN_V0_NETWORK.caip2 && item.asset === LEAN_V0_NETWORK.usdcSac
  );
  if (!requirement) throw new Error(`No supported exact ${ACTIVE_NETWORK_LABEL} USDC payment option was offered`);
  return { required, requirement, option: validateRequirement(requirement) };
}

export function validatePaymentSignature(header: string, quoted: PaymentRequirements): PaymentPayload {
  if (!header || header.length > 128_000) throw new Error('The payment signature is missing or too large');
  const payload = decodePaymentSignatureHeader(header);
  const accepted = payload.accepted;
  for (const field of ['scheme', 'network', 'asset', 'amount', 'payTo'] as const) {
    if (accepted[field] !== quoted[field]) throw new Error(`Signed payment does not match the quoted ${field}`);
  }
  validateRequirement(accepted);
  return payload;
}

export function settlementTransaction(header: string | null): string | undefined {
  if (!header) return undefined;
  try {
    const settlement = decodePaymentResponseHeader(header);
    return settlement.success && typeof settlement.transaction === 'string' ? settlement.transaction : undefined;
  } catch {
    return undefined;
  }
}

export function quoteHash(value: string) {
  return createHash('sha256').update(value).digest('hex');
}
