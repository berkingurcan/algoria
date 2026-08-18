import { Networks } from '@creit.tech/stellar-wallets-kit/types';
import { LEAN_V0_NETWORK } from '$lib/constants';

let kitPromise: Promise<typeof import('@creit.tech/stellar-wallets-kit/sdk').StellarWalletsKit> | null = null;

export function getWalletKit() {
  if (!kitPromise) {
    kitPromise = Promise.all([
      import('@creit.tech/stellar-wallets-kit/sdk'),
      import('@creit.tech/stellar-wallets-kit/modules/utils')
    ]).then(([{ StellarWalletsKit }, { defaultModules }]) => {
      StellarWalletsKit.init({ modules: defaultModules(), network: LEAN_V0_NETWORK.passphrase as Networks });
      return StellarWalletsKit;
    }).catch((error) => {
      kitPromise = null;
      throw error;
    });
  }
  return kitPromise;
}
