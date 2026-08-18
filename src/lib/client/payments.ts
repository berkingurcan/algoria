import type { JobCard } from '$lib/types/chat';
import { ACTIVE_NETWORK_LABEL, LEAN_V0_MAX_PAYMENT_USDC, LEAN_V0_NETWORK } from '$lib/constants';
import { isWithinUsdcCap } from '$lib/utils/money';
import { getWalletKit } from './wallet';

async function activeWallet(expectedAddress: string) {
  const StellarWalletsKit = await getWalletKit();
  let address = '';
  try { address = (await StellarWalletsKit.getAddress()).address; } catch { /* select below */ }
  if (!address) address = (await StellarWalletsKit.authModal()).address;
  if (address !== expectedAddress) throw new Error('The selected wallet does not match the authenticated wallet');
  return { StellarWalletsKit, address };
}

function assertPayment(job: JobCard) {
  const payment = job.payment;
  if (!payment) throw new Error('This job has no payment quote');
  if (payment.protocol !== 'x402') throw new Error('Only exact x402 payment is enabled in lean v0');
  if (payment.network !== LEAN_V0_NETWORK.caip2 || payment.asset !== LEAN_V0_NETWORK.usdcSac ||
    !isWithinUsdcCap(payment.amountAtomic, LEAN_V0_MAX_PAYMENT_USDC)) {
    throw new Error(`The quote failed the ${ACTIVE_NETWORK_LABEL} USDC safety policy`);
  }
  if (!/^G[A-Z2-7]{55}$/.test(payment.payTo)) throw new Error('The quoted recipient is invalid');
  if (new Date(payment.expiresAt).getTime() <= Date.now()) throw new Error('The payment quote expired before signing. Request a new quote to continue.');
  return payment;
}

export async function createPaymentCredential(job: JobCard, walletAddress: string): Promise<string> {
  const payment = assertPayment(job);
  const wallet = await activeWallet(walletAddress);
  const [{ x402Client }, { ExactStellarScheme }, { decodePaymentRequiredHeader, encodePaymentSignatureHeader }] = await Promise.all([
    import('@x402/core/client'), import('@x402/stellar/exact/client'), import('@x402/core/http')
  ]);
  const required = decodePaymentRequiredHeader(payment.paymentRequired);
  const option = required.accepts.find((item) =>
    item.scheme === 'exact' && item.network === LEAN_V0_NETWORK.caip2 && item.asset === LEAN_V0_NETWORK.usdcSac &&
    item.amount === payment.amountAtomic && item.payTo === payment.payTo
  );
  if (!option) throw new Error('The signed x402 quote no longer matches the reviewed payment');
  const signer = {
    address: wallet.address,
    signAuthEntry: (entry: string, options?: { networkPassphrase?: string; address?: string }) =>
      wallet.StellarWalletsKit.signAuthEntry(entry, {
        networkPassphrase: options?.networkPassphrase ?? LEAN_V0_NETWORK.passphrase,
        address: wallet.address
      }),
    signTransaction: (xdr: string, options?: { networkPassphrase?: string; address?: string }) =>
      wallet.StellarWalletsKit.signTransaction(xdr, {
        networkPassphrase: options?.networkPassphrase ?? LEAN_V0_NETWORK.passphrase,
        address: wallet.address
      })
  };
  const client = new x402Client().register(
    LEAN_V0_NETWORK.caip2,
    new ExactStellarScheme(signer, { url: LEAN_V0_NETWORK.rpcUrl })
  );
  return encodePaymentSignatureHeader(await client.createPaymentPayload(required));
}

/**
 * Signs a reputation entry the server assembled for this wallet. The contract
 * records feedback from its caller, so the signature has to be the client's
 * own; Algoria assembles and submits, and never holds a key that could author
 * reputation on anyone's behalf. The server re-reads the signed transaction
 * before submitting it, so a wallet returning something else is caught there.
 */
export async function signFeedbackTransaction(
  transaction: string,
  networkPassphrase: string,
  walletAddress: string
): Promise<string> {
  const wallet = await activeWallet(walletAddress);
  const { signedTxXdr } = await wallet.StellarWalletsKit.signTransaction(transaction, {
    networkPassphrase,
    address: wallet.address
  });
  return signedTxXdr;
}
