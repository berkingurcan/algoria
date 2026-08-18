import { describe, expect, it } from 'vitest';
import { LEAN_V0_NETWORK } from '$lib/constants';
import { assertLeanV0Feature, assertLeanV0Selection, validateLeanV0Configuration } from './policy';

const allowedResource = {
  source: 'stellar8004',
  agent8004Id: 42,
  protocols: ['http', 'x402'],
  pricing: {
    scheme: 'exact',
    network: LEAN_V0_NETWORK.caip2,
    asset: LEAN_V0_NETWORK.usdcSac
  }
};

describe('lean v0 policy', () => {
  it('accepts only the exact testnet profile', () => {
    expect(validateLeanV0Configuration({
      STELLAR_NETWORK: LEAN_V0_NETWORK.caip2,
      STELLAR_RPC_URL: LEAN_V0_NETWORK.rpcUrl,
      MAX_PAYMENT_USDC: '1'
    })).toMatchObject(LEAN_V0_NETWORK);

    expect(() => validateLeanV0Configuration({ STELLAR_NETWORK: 'stellar:pubnet' })).toThrow(/stellar:testnet/);
    expect(() => validateLeanV0Configuration({ STELLAR_RPC_URL: 'https://mainnet.sorobanrpc.com' })).toThrow(/soroban-testnet/);
    expect(() => validateLeanV0Configuration({ MAX_PAYMENT_USDC: '2' })).toThrow(/MAX_PAYMENT_USDC <= 1/);
    expect(() => validateLeanV0Configuration({ MAX_PAYMENT_USDC: '0' })).toThrow(/MAX_PAYMENT_USDC <= 1/);
    expect(() => validateLeanV0Configuration({ MAX_PAYMENT_USDC: '-1' })).toThrow(/MAX_PAYMENT_USDC <= 1/);
    // An operator may tighten the cap for a real-money trial, but never raise it.
    expect(validateLeanV0Configuration({ MAX_PAYMENT_USDC: '0.1' }).maxPaymentUsdc).toBe(0.1);
  });

  it('allows only allowlisted 8004 HTTP+x402 services', () => {
    expect(() => assertLeanV0Selection(allowedResource, new Set([42]))).not.toThrow();
    expect(() => assertLeanV0Selection(allowedResource, new Set())).toThrow(/not allowlisted/);
    expect(() => assertLeanV0Selection({ ...allowedResource, source: 'x402-bazaar' }, new Set([42]))).toThrow(/Bazaar/);
    expect(() => assertLeanV0Selection({ ...allowedResource, protocols: ['mcp'] }, new Set([42]))).toThrow(/Runtime MCP execution is outside the lean v0 policy/);
    expect(() => assertLeanV0Selection({
      ...allowedResource,
      pricing: { ...allowedResource.pricing, network: 'stellar:pubnet' }
    }, new Set([42]))).toThrow(/testnet USDC/);
  });

  it('keeps every later-phase feature disabled', () => {
    expect(() => assertLeanV0Feature('httpExecution')).not.toThrow();
    expect(() => assertLeanV0Feature('x402Payment')).not.toThrow();
    // Mainnet is deliberately absent: it was opened once a registered agent on
    // pubnet answered a standard x402 challenge in the pinned asset. Everything
    // still listed here remains outside lean v0.
    expect(() => assertLeanV0Feature('mainnet')).not.toThrow();
    // Feedback opened with the first settled payment: reputation that no
    // payment stands behind is what the registry exists to exclude.
    expect(() => assertLeanV0Feature('feedback')).not.toThrow();
    for (const feature of ['openCatalogDiscovery', 'bazaarRouting', 'mcpExecution', 'mppPayment', 'a2aExecution'] as const) {
      expect(() => assertLeanV0Feature(feature)).toThrow(/outside the lean v0 policy/);
    }
  });
});
