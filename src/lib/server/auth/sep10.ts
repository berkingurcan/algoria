import { createHash } from 'node:crypto';
import { env } from '$env/dynamic/private';
import { env as publicEnv } from '$env/dynamic/public';
import { Keypair, StrKey, TransactionBuilder, WebAuth } from '@stellar/stellar-sdk';
import { ACTIVE_NETWORK_PASSPHRASE } from '$lib/constants';
import { getAdminClient } from '$lib/server/db/client';

function authDomain(): string {
  const origin = publicEnv.PUBLIC_APP_ORIGIN || 'http://localhost:5173';
  return new URL(origin).host;
}

function serverKeypair(): Keypair {
  if (!env.SEP10_SIGNING_SECRET) throw new Error('SEP10_SIGNING_SECRET is not configured');
  return Keypair.fromSecret(env.SEP10_SIGNING_SECRET);
}

function transactionHash(xdr: string): string {
  return createHash('sha256')
    .update(TransactionBuilder.fromXDR(xdr, ACTIVE_NETWORK_PASSPHRASE).hash())
    .digest('hex');
}

export async function createSep10Challenge(account: string): Promise<{ transaction: string; networkPassphrase: string }> {
  if (!StrKey.isValidEd25519PublicKey(account)) throw new Error('A valid Stellar G-address is required');
  const domain = authDomain();
  const keypair = serverKeypair();
  const transaction = WebAuth.buildChallengeTx(keypair, account, domain, 300, ACTIVE_NETWORK_PASSPHRASE, domain);
  const hash = transactionHash(transaction);
  const { error } = await getAdminClient().from('sep10_challenges').insert({
    challenge_hash: hash,
    stellar_address: account,
    expires_at: new Date(Date.now() + 5 * 60_000).toISOString()
  });
  if (error) throw error;
  return { transaction, networkPassphrase: ACTIVE_NETWORK_PASSPHRASE };
}

export async function verifySep10Challenge(signedTransaction: string): Promise<string> {
  if (signedTransaction.length > 20_000) throw new Error('Challenge transaction is too large');
  const domain = authDomain();
  const server = serverKeypair();
  const parsed = WebAuth.readChallengeTx(signedTransaction, server.publicKey(), ACTIVE_NETWORK_PASSPHRASE, domain, domain);
  const account = parsed.clientAccountID;
  const signers = WebAuth.verifyChallengeTxSigners(
    signedTransaction, server.publicKey(), ACTIVE_NETWORK_PASSPHRASE, [account], domain, domain
  );
  if (!signers.includes(account)) throw new Error('The challenge was not signed by the requested wallet');
  const hash = transactionHash(signedTransaction);
  const admin = getAdminClient();
  const { data, error } = await admin.from('sep10_challenges')
    .update({ consumed_at: new Date().toISOString() })
    .eq('challenge_hash', hash)
    .eq('stellar_address', account)
    .is('consumed_at', null)
    .gt('expires_at', new Date().toISOString())
    .select('challenge_hash')
    .maybeSingle();
  if (error || !data) throw new Error('Challenge is expired, unknown, or already used');
  return account;
}
