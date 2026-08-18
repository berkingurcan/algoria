import type { LayoutServerLoad } from './$types';
import { ACTIVE_NETWORK_IS_MAINNET, ACTIVE_NETWORK_LABEL, ACTIVE_ASSET_LABEL, LEAN_V0_MAX_PAYMENT_USDC } from '$lib/constants';
import { assertLeanV0Configuration } from '$lib/server/network/policy';

export const load: LayoutServerLoad = async ({ locals }) => ({
  auth: locals.auth ? { userId: locals.auth.userId, walletAddress: locals.auth.walletAddress } : null,
  // The cap the server will actually enforce, not the default it falls back to.
  // The interface quotes this number as a promise, so reading it from anywhere
  // else would let the promise and the enforcement drift apart.
  policy: {
    network: ACTIVE_NETWORK_LABEL,
    asset: ACTIVE_ASSET_LABEL,
    isMainnet: ACTIVE_NETWORK_IS_MAINNET,
    maxPaymentUsdc: (() => {
      try {
        return assertLeanV0Configuration().maxPaymentUsdc;
      } catch {
        return LEAN_V0_MAX_PAYMENT_USDC;
      }
    })()
  }
});
