import { describe, expect, it } from 'vitest';
import { Networks } from '@stellar/stellar-sdk';
import {
  STELLAR_PUBNET_CAIP2,
  STELLAR_TESTNET_CAIP2,
  USDC_PUBNET_ADDRESS,
  USDC_TESTNET_ADDRESS
} from '@x402/stellar';
import { MAINNET_CONFIG, TESTNET_CONFIG } from '@trionlabs/stellar8004';
import { ACTIVE_NETWORK, DEFAULT_NETWORK, LEAN_V0_NETWORK, NETWORK_PROFILES, isNetworkId } from './constants';

describe('Stellar network profiles', () => {
  it('pins the testnet profile to the installed SDK constants', () => {
    const testnet = NETWORK_PROFILES['stellar:testnet'];
    expect(testnet.caip2).toBe(STELLAR_TESTNET_CAIP2);
    expect(testnet.passphrase).toBe(Networks.TESTNET);
    expect(testnet.rpcUrl).toBe(TESTNET_CONFIG.rpcUrl);
    expect(testnet.usdcSac).toBe(USDC_TESTNET_ADDRESS);
    expect(testnet.contracts).toEqual(TESTNET_CONFIG.contracts);
  });

  it('pins the mainnet profile to the installed SDK constants', () => {
    const mainnet = NETWORK_PROFILES['stellar:pubnet'];
    expect(mainnet.caip2).toBe(STELLAR_PUBNET_CAIP2);
    expect(mainnet.passphrase).toBe(Networks.PUBLIC);
    expect(mainnet.rpcUrl).toBe(MAINNET_CONFIG.rpcUrl);
    expect(mainnet.usdcSac).toBe(USDC_PUBNET_ADDRESS);
    expect(mainnet.contracts).toEqual(MAINNET_CONFIG.contracts);
  });

  it('never lets the two profiles share a value that must differ', () => {
    const testnet = NETWORK_PROFILES['stellar:testnet'];
    const mainnet = NETWORK_PROFILES['stellar:pubnet'];
    for (const key of ['caip2', 'passphrase', 'rpcUrl', 'horizonUrl', 'usdcSac'] as const) {
      expect(testnet[key]).not.toBe(mainnet[key]);
    }
    expect(testnet.contracts.identity).not.toBe(mainnet.contracts.identity);
  });

  it('defaults to testnet and rejects unknown network ids', () => {
    expect(DEFAULT_NETWORK).toBe('stellar:testnet');
    expect(ACTIVE_NETWORK).toBe('stellar:testnet');
    expect(LEAN_V0_NETWORK).toEqual(NETWORK_PROFILES[ACTIVE_NETWORK]);
    expect(isNetworkId('stellar:pubnet')).toBe(true);
    expect(isNetworkId('stellar:mainnet')).toBe(false);
    expect(isNetworkId(undefined)).toBe(false);
  });
});
