import { env } from '$env/dynamic/public';

/**
 * One deployment serves exactly one network. The profile is selected by
 * `PUBLIC_STELLAR_NETWORK` so the browser and the server agree without extra
 * plumbing, and `policy.ts` re-derives the selected profile from the installed
 * SDKs on every request, so a wrong or drifted value fails closed rather than
 * silently pointing real value at the wrong chain.
 */
export const NETWORK_PROFILES = {
  'stellar:testnet': {
    environment: 'testnet',
    caip2: 'stellar:testnet',
    passphrase: 'Test SDF Network ; September 2015',
    rpcUrl: 'https://soroban-testnet.stellar.org',
    horizonUrl: 'https://horizon-testnet.stellar.org',
    explorerNetwork: 'testnet',
    usdcSac: 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA',
    contracts: {
      identity: 'CDE3K4COIAGWNNJQQLL26SYI3KBJF5FUDHXG5FA6GYDJCG7T5V7FIWZH',
      reputation: 'CBZEAGIEI3HXMDRLF44KLQJQQOH6LCYWWSGJVSYQYQO2HQ6DDGZ7HT55',
      validation: 'CC5USZRO26MOIAVNYTTJDS63C2OBBLREOAOET4CPF2EZWO3YFKLMO3SL'
    }
  },
  'stellar:pubnet': {
    environment: 'mainnet',
    caip2: 'stellar:pubnet',
    passphrase: 'Public Global Stellar Network ; September 2015',
    rpcUrl: 'https://mainnet.sorobanrpc.com',
    horizonUrl: 'https://horizon.stellar.org',
    explorerNetwork: 'public',
    usdcSac: 'CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75',
    contracts: {
      identity: 'CBGPDCJIHQ32G42BE7F2CIT3YW6XRN5ED6GQJHCRZSNAYH6TGMCL6X35',
      reputation: 'CBOIAIMMWAXI57OATLX6BWVDQLCC4YU55HV6MZXFRP6CBSGAMXSTEPPA',
      validation: 'CBT6WWEVEPT2UFGFGVJJ7ELYGLQAGRYSVGDTGMCJTRWXOH27MWUO7UJG'
    }
  }
} as const;

export type NetworkId = keyof typeof NETWORK_PROFILES;
export const DEFAULT_NETWORK: NetworkId = 'stellar:testnet';

export function isNetworkId(value: string | undefined): value is NetworkId {
  return value === 'stellar:testnet' || value === 'stellar:pubnet';
}

const requested = env.PUBLIC_STELLAR_NETWORK;
/** An unrecognised value resolves to testnet; the private-env check then rejects the mismatch. */
export const ACTIVE_NETWORK: NetworkId = isNetworkId(requested) ? requested : DEFAULT_NETWORK;

export const LEAN_V0_NETWORK = NETWORK_PROFILES[ACTIVE_NETWORK];

export type LeanV0NetworkProfile = typeof NETWORK_PROFILES[NetworkId];

export const LEAN_V0_FEATURES = {
  httpExecution: true,
  x402Payment: true,
  openCatalogDiscovery: false,
  bazaarRouting: false,
  mcpExecution: false,
  mppPayment: false,
  a2aExecution: false,
  // Opened once a payment had actually settled: the registry counts unique
  // paying clients, so an entry Algoria could write before it could pay would
  // have been the exact noise the registry exists to keep out. The write is
  // signed by the client's own wallet. Algoria holds no key that could author
  // reputation on anyone's behalf.
  feedback: true,
  // Held shut until a mainnet deployment had something to route to. Agent 67
  // settles real USDC on pubnet daily and answers a standard x402 challenge in
  // the asset this profile already pins, so the network is no longer the thing
  // standing in the way. A testnet deployment is unaffected either way: the
  // gate only fires when the active network is pubnet.
  mainnet: true
} as const;

export type LeanV0Feature = keyof typeof LEAN_V0_FEATURES;

export const ACTIVE_NETWORK_PASSPHRASE = LEAN_V0_NETWORK.passphrase;

/**
 * What the interface calls this network, derived rather than written down. A
 * deployment that moves real USDC must never describe itself as a test
 * network: the label is the whole basis on which someone decides how much
 * care an amount deserves.
 */
export const ACTIVE_NETWORK_IS_MAINNET = LEAN_V0_NETWORK.environment === 'mainnet';
export const ACTIVE_NETWORK_LABEL = ACTIVE_NETWORK_IS_MAINNET ? 'Stellar mainnet' : 'Stellar testnet';
/** For running text, where "1 testnet USDC" reads naturally but "1 mainnet USDC" does not. */
export const ACTIVE_ASSET_LABEL = ACTIVE_NETWORK_IS_MAINNET ? 'USDC' : 'testnet USDC';
export const LEAN_V0_MAX_PAYMENT_USDC = 1;
/** Rolling per-wallet ceiling; the per-payment cap alone cannot bound repeated spend. */
export const LEAN_V0_DAILY_SPEND_USDC = 2;
export const LEAN_V0_SPEND_WINDOW_HOURS = 24;
export const USDC_DECIMALS = 7;

export const STELLAR_8004_IDENTITY_CONTRACT = LEAN_V0_NETWORK.contracts.identity;
export const STELLAR_8004_REPUTATION_CONTRACT = LEAN_V0_NETWORK.contracts.reputation;
export const STELLAR_8004_VALIDATION_CONTRACT = LEAN_V0_NETWORK.contracts.validation;

export const MESSAGE_RETENTION_DAYS = 30;
export const RECEIPT_RETENTION_DAYS = 365;
