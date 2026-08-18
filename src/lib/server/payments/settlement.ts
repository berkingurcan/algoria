import { Asset } from '@stellar/stellar-sdk';
import { LEAN_V0_NETWORK } from '$lib/constants';
import { usdcToAtomic } from '$lib/utils/money';
import { safeExternalFetch, readBoundedResponse } from '$lib/server/security/egress';

/**
 * A facilitator's `PAYMENT-RESPONSE` header is a claim, not proof. Before a Job is
 * marked complete, the claimed settlement is re-derived from the ledger: the
 * transaction must exist, have succeeded, and contain a transfer of the exact
 * asset, amount, and recipient the user approved.
 */
export type SettlementVerification =
  | { status: 'verified'; ledger: number }
  | { status: 'mismatch'; reason: string }
  | { status: 'not-found' }
  | { status: 'unavailable'; reason: string };

export interface SettlementExpectation {
  amountAtomic: string;
  payTo: string;
}

type BalanceChange = {
  asset_code?: unknown;
  asset_issuer?: unknown;
  type?: unknown;
  from?: unknown;
  to?: unknown;
  amount?: unknown;
};

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** The ledger reports classic (code, issuer); the reviewed quote names a SAC address. */
function matchesPinnedAsset(change: BalanceChange): boolean {
  if (typeof change.asset_code !== 'string' || typeof change.asset_issuer !== 'string') return false;
  try {
    return new Asset(change.asset_code, change.asset_issuer).contractId(LEAN_V0_NETWORK.passphrase) === LEAN_V0_NETWORK.usdcSac;
  } catch {
    return false;
  }
}

function transferMatches(change: BalanceChange, expected: SettlementExpectation): boolean {
  if (change.type !== 'transfer' || change.to !== expected.payTo) return false;
  if (typeof change.amount !== 'string' || !matchesPinnedAsset(change)) return false;
  try {
    return usdcToAtomic(change.amount) === expected.amountAtomic;
  } catch {
    return false;
  }
}

export function isValidTransactionHash(value: string): boolean {
  return /^[0-9a-f]{64}$/i.test(value);
}

/** Pure decision over Horizon payloads, so the rule is testable without the network. */
export function interpretSettlement(
  transaction: unknown,
  operations: unknown,
  expected: SettlementExpectation
): SettlementVerification {
  const body = record(transaction);
  if (body.successful !== true) {
    return { status: 'mismatch', reason: 'The settlement transaction did not succeed on the ledger' };
  }
  const ledger = typeof body.ledger === 'number' ? body.ledger : 0;
  const records = record(record(operations)._embedded).records;
  const changes = (Array.isArray(records) ? records : []).flatMap((operation) => {
    const list = record(operation).asset_balance_changes;
    return Array.isArray(list) ? list as BalanceChange[] : [];
  });
  if (changes.some((change) => transferMatches(change, expected))) return { status: 'verified', ledger };
  return { status: 'mismatch', reason: 'The settlement transaction does not contain the approved transfer' };
}

/** Horizon answers as `application/hal+json`, which the shared reader leaves as text. */
export function parseHorizonBody(body: unknown): unknown {
  if (typeof body !== 'string') return body;
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

async function horizonJson(path: string): Promise<{ ok: boolean; status: number; body: unknown }> {
  const { response } = await safeExternalFetch(new URL(path, LEAN_V0_NETWORK.horizonUrl).toString(), {
    method: 'GET',
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(15_000)
  });
  return { ok: response.ok, status: response.status, body: parseHorizonBody(await readBoundedResponse(response)) };
}

/**
 * When a paid request comes back without a settlement reference, the ledger can
 * still answer the only question that matters to the payer: was anything taken?
 * This looks for the approved transfer among the recipient's recent payments.
 *
 * `absent` is only returned when the lookup succeeded and found nothing, so a
 * Horizon failure can never be mistaken for proof that no payment happened.
 */
export async function findSettlementFromPayer(input: {
  payer: string;
  payTo: string;
  amountAtomic: string;
  sinceIso: string;
  /**
   * Transactions already recorded against another payment. Every call to one
   * service costs the same, so a second job produces a transfer identical to
   * the first in payer, recipient, asset and amount, the ledger cannot tell
   * them apart, and matching the wrong one would settle a job against someone
   * else's receipt. Only the transactions this deployment has not already
   * claimed are eligible.
   */
  claimed?: readonly string[];
}): Promise<{ status: 'found'; txHash: string } | { status: 'absent' } | { status: 'unavailable' }> {
  try {
    const response = await horizonJson(`/accounts/${input.payTo}/payments?order=desc&limit=50`);
    if (!response.ok) return { status: 'unavailable' };
    const records = record(record(response.body)._embedded).records;
    if (!Array.isArray(records)) return { status: 'unavailable' };
    const since = Date.parse(input.sinceIso);
    const claimed = new Set(input.claimed ?? []);
    // Horizon answers newest first, so the earliest eligible transfer is the
    // last one seen. That is the one this job paid for: anything later belongs
    // to a job created after it.
    let earliest: string | undefined;
    for (const entry of records) {
      const row = record(entry);
      if (typeof row.created_at === 'string' && Date.parse(row.created_at) < since) continue;
      if (typeof row.transaction_hash !== 'string' || claimed.has(row.transaction_hash)) continue;
      const changes = Array.isArray(row.asset_balance_changes) ? row.asset_balance_changes as BalanceChange[] : [];
      const match = changes.some((change) =>
        change.from === input.payer && transferMatches(change, { amountAtomic: input.amountAtomic, payTo: input.payTo })
      );
      if (match) earliest = row.transaction_hash;
    }
    return earliest ? { status: 'found', txHash: earliest } : { status: 'absent' };
  } catch {
    return { status: 'unavailable' };
  }
}

export async function verifySettlementOnChain(
  txHash: string,
  expected: SettlementExpectation
): Promise<SettlementVerification> {
  if (!isValidTransactionHash(txHash)) {
    return { status: 'mismatch', reason: 'The settlement reference is not a Stellar transaction hash' };
  }
  const hash = txHash.toLowerCase();
  try {
    const transaction = await horizonJson(`/transactions/${hash}`);
    if (transaction.status === 404) return { status: 'not-found' };
    if (!transaction.ok) return { status: 'unavailable', reason: `Horizon returned ${transaction.status}` };
    const operations = await horizonJson(`/transactions/${hash}/operations`);
    if (!operations.ok) return { status: 'unavailable', reason: `Horizon returned ${operations.status}` };
    return interpretSettlement(transaction.body, operations.body, expected);
  } catch (error) {
    return { status: 'unavailable', reason: error instanceof Error ? error.message : 'Ledger lookup failed' };
  }
}
