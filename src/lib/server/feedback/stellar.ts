import { createHash } from 'node:crypto';
import { Address, TransactionBuilder, xdr } from '@stellar/stellar-sdk';
import { ReputationClient } from '@trionlabs/stellar8004';
import { ACTIVE_NETWORK_PASSPHRASE, LEAN_V0_NETWORK } from '$lib/constants';

export interface ExpectedFeedback {
  walletAddress: string;
  agentId: number;
  score: number;
  tag1: string;
  tag2?: string;
  endpoint: string;
  feedbackId: string;
}

export function feedbackUri(feedbackId: string) {
  return `urn:algoria:feedback:${feedbackId}`;
}

export function feedbackHash(feedbackId: string) {
  return createHash('sha256').update(feedbackUri(feedbackId)).digest();
}

/**
 * The registry stores a score as an integer plus a decimal count. Algoria only
 * ever offers whole steps, so the count is zero and the number on the ledger is
 * the number the user picked, with nothing to reconstruct when reading it back.
 */
export const FEEDBACK_VALUE_DECIMALS = 0;

/** The steps the interface offers; the database enforces the same set. */
export function isFeedbackScore(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 20 && value <= 100 && value % 20 === 0;
}

/**
 * Builds the unsigned reputation entry for the wallet that paid for the job.
 *
 * The contract records feedback from `caller`, so the entry has to be signed by
 * the client's own key, which Algoria never holds. The transaction is
 * therefore assembled and simulated here against the user's address and handed
 * back unsigned; the wallet signs it, and `verifyFeedbackTransaction` checks
 * that what came back is still the entry the user was shown.
 */
export async function buildFeedbackTransaction(expected: ExpectedFeedback): Promise<string> {
  const client = new ReputationClient({
    contractId: LEAN_V0_NETWORK.contracts.reputation,
    networkPassphrase: LEAN_V0_NETWORK.passphrase,
    rpcUrl: LEAN_V0_NETWORK.rpcUrl,
    publicKey: expected.walletAddress,
    // The wallet signs. Reaching this would mean the server was asked to, which
    // is the one thing this design does not do.
    signTransaction: () => {
      throw new Error('Algoria does not sign reputation entries');
    }
  });

  const assembled = await client.give_feedback({
    caller: expected.walletAddress,
    agent_id: expected.agentId,
    value: BigInt(expected.score),
    value_decimals: FEEDBACK_VALUE_DECIMALS,
    tag1: expected.tag1,
    tag2: expected.tag2 ?? '',
    endpoint: expected.endpoint,
    feedback_uri: feedbackUri(expected.feedbackId),
    feedback_hash: feedbackHash(expected.feedbackId)
  }, { timeoutInSeconds: 30 });

  return assembled.toXDR();
}

function invocationArgs(transaction: string): xdr.ScVal[] | undefined {
  const parsed = TransactionBuilder.fromXDR(transaction, ACTIVE_NETWORK_PASSPHRASE);
  const operations = 'operations' in parsed ? parsed.operations : [];
  if (operations.length !== 1) return undefined;
  const operation = operations[0];
  if (operation.type !== 'invokeHostFunction') return undefined;
  const hostFunction = operation.func;
  if (hostFunction.switch() !== xdr.HostFunctionType.hostFunctionTypeInvokeContract()) return undefined;
  const invocation = hostFunction.invokeContract();
  const contract = Address.fromScAddress(invocation.contractAddress()).toString();
  if (contract !== LEAN_V0_NETWORK.contracts.reputation) return undefined;
  if (invocation.functionName().toString() !== 'give_feedback') return undefined;
  return invocation.args();
}

/**
 * A wallet signs whatever transaction it is handed, so the signed result is
 * checked against the entry the user approved rather than trusted because it
 * came back from the same session. A submission that names another agent,
 * another score, or another author is refused. The reputation Algoria writes
 * has to be the reputation its user meant to write.
 */
export function verify8004FeedbackTransaction(transaction: unknown, expected: ExpectedFeedback): void {
  if (typeof transaction !== 'string' || !transaction.trim() || transaction.length > 64_000) {
    throw new Error('The signed reputation entry is missing or too large');
  }
  let args: xdr.ScVal[] | undefined;
  try {
    args = invocationArgs(transaction);
  } catch {
    throw new Error('The signed reputation entry could not be read');
  }
  if (!args || args.length !== 9) throw new Error('The signed transaction is not a reputation entry for this registry');

  const [caller, agentId, value, valueDecimals, tag1, tag2, endpoint, uri, hash] = args;
  const address = Address.fromScAddress(caller.address()).toString();
  if (address !== expected.walletAddress) throw new Error('The reputation entry names a different author');
  if (agentId.u32() !== expected.agentId) throw new Error('The reputation entry names a different agent');
  if (Number(value.i128().lo().toString()) !== expected.score) throw new Error('The reputation entry carries a different score');
  if (valueDecimals.u32() !== FEEDBACK_VALUE_DECIMALS) throw new Error('The reputation entry carries a different scale');
  if (tag1.str().toString() !== expected.tag1) throw new Error('The reputation entry carries a different tag');
  if (tag2.str().toString() !== (expected.tag2 ?? '')) throw new Error('The reputation entry carries a different second tag');
  if (endpoint.str().toString() !== expected.endpoint) throw new Error('The reputation entry names a different endpoint');
  if (uri.str().toString() !== feedbackUri(expected.feedbackId)) throw new Error('The reputation entry references a different record');
  if (!Buffer.from(hash.bytes()).equals(feedbackHash(expected.feedbackId))) {
    throw new Error('The reputation entry carries a different record hash');
  }
}
