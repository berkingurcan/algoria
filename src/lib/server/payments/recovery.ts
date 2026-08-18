import { recoverSnapshot, responseResult, type RequestSnapshot } from '$lib/server/execution/http';

export type ProviderRecovery = {
  kind: 'succeeded' | 'processing' | 'uncertain' | 'failed';
  result: { status: number; body: unknown; txHash?: string };
};

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/**
 * Maps a controlled-provider status body onto a bounded recovery outcome.
 * A `succeeded` without a settled Payment Receipt is downgraded to `uncertain`
 * so a bare 200 can never complete a Job without settlement evidence.
 */
export function interpretRecoveryResult(result: { status: number; body: unknown }): ProviderRecovery | null {
  const body = record(result.body);
  const status = body.status;
  if (!['succeeded', 'processing', 'uncertain', 'failed'].includes(String(status))) return null;
  const receipt = record(body.paymentReceipt);
  const settlementReference = typeof receipt.settlementReference === 'string' ? receipt.settlementReference : undefined;
  return {
    kind: status === 'succeeded' && !settlementReference ? 'uncertain' : status as ProviderRecovery['kind'],
    result: { ...result, txHash: settlementReference }
  };
}

/** One same-origin, token-authenticated status lookup; never resubmits a payment credential. */
export async function fetchProviderRecovery(snapshot: RequestSnapshot): Promise<ProviderRecovery | null> {
  const recovered = await recoverSnapshot(snapshot);
  if (!recovered) return null;
  return interpretRecoveryResult(await responseResult(recovered.response));
}
