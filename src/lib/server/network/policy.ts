import { env } from '$env/dynamic/private';
import { Networks } from '@stellar/stellar-sdk';
import { STELLAR_PUBNET_CAIP2, STELLAR_TESTNET_CAIP2, USDC_PUBNET_ADDRESS, USDC_TESTNET_ADDRESS } from '@x402/stellar';
import { MAINNET_CONFIG, TESTNET_CONFIG } from '@trionlabs/stellar8004';
import {
  ACTIVE_NETWORK,
  ACTIVE_NETWORK_LABEL,
  LEAN_V0_FEATURES,
  LEAN_V0_MAX_PAYMENT_USDC,
  LEAN_V0_NETWORK,
  type LeanV0Feature
} from '$lib/constants';

type EnvironmentInput = {
  STELLAR_NETWORK?: string;
  STELLAR_RPC_URL?: string;
  MAX_PAYMENT_USDC?: string;
};

type UnknownRecord = Record<string, unknown>;

export class NetworkPolicyError extends Error {
  readonly code = 'network-policy-mismatch';
}

const POLICY_FEATURE_LABELS: Record<string, string> = {
  httpExecution: 'HTTP execution',
  x402Payment: 'x402 payment',
  openCatalogDiscovery: 'Open catalog discovery',
  bazaarRouting: 'Public Bazaar routing',
  mcpExecution: 'Runtime MCP execution',
  mppPayment: 'MPP payment',
  a2aExecution: 'Agent-to-agent execution',
  feedback: 'On-chain feedback',
  mainnet: 'Mainnet execution',
  executionProtocol: 'This execution protocol',
  catalogSource: 'This catalog source',
  agentAllowlist: 'This agent identity',
  paymentPolicy: 'This payment policy'
};

export class UnsupportedPolicyError extends Error {
  readonly code = 'unsupported-policy';

  constructor(readonly feature: string, message?: string) {
    super(message ?? `${POLICY_FEATURE_LABELS[feature] ?? feature} is outside the lean v0 policy`);
  }
}

/** Re-derives the active profile from the installed SDKs, so drift or a wrong network fails closed. */
function assertPinnedSdkProfile(): void {
  const mainnet = ACTIVE_NETWORK === 'stellar:pubnet';
  const sdk = mainnet ? MAINNET_CONFIG : TESTNET_CONFIG;
  const matches = LEAN_V0_NETWORK.caip2 === (mainnet ? STELLAR_PUBNET_CAIP2 : STELLAR_TESTNET_CAIP2)
    && LEAN_V0_NETWORK.passphrase === (mainnet ? Networks.PUBLIC : Networks.TESTNET)
    && LEAN_V0_NETWORK.passphrase === sdk.networkPassphrase
    && LEAN_V0_NETWORK.rpcUrl === sdk.rpcUrl
    && LEAN_V0_NETWORK.usdcSac === (mainnet ? USDC_PUBNET_ADDRESS : USDC_TESTNET_ADDRESS)
    && LEAN_V0_NETWORK.contracts.identity === sdk.contracts.identity
    && LEAN_V0_NETWORK.contracts.reputation === sdk.contracts.reputation
    && LEAN_V0_NETWORK.contracts.validation === sdk.contracts.validation;
  if (!matches) {
    throw new NetworkPolicyError(`The pinned Stellar, x402, and Stellar 8004 ${LEAN_V0_NETWORK.environment} profiles disagree`);
  }
  if (mainnet && !LEAN_V0_FEATURES.mainnet) {
    throw new NetworkPolicyError('Mainnet is disabled by the lean v0 feature policy');
  }
}

export function validateLeanV0Configuration(input: EnvironmentInput) {
  assertPinnedSdkProfile();
  const network = input.STELLAR_NETWORK?.trim() || LEAN_V0_NETWORK.caip2;
  if (network !== LEAN_V0_NETWORK.caip2) {
    throw new NetworkPolicyError(`Lean v0 requires STELLAR_NETWORK=${LEAN_V0_NETWORK.caip2}`);
  }

  const rpcUrl = input.STELLAR_RPC_URL?.trim() || LEAN_V0_NETWORK.rpcUrl;
  if (rpcUrl !== LEAN_V0_NETWORK.rpcUrl) {
    throw new NetworkPolicyError(`Lean v0 requires STELLAR_RPC_URL=${LEAN_V0_NETWORK.rpcUrl}`);
  }

  // The pinned value is a ceiling, not a fixed setting: an operator may tighten the
  // per-payment cap (for a real-money trial, say) but can never raise it by config.
  const maxPaymentUsdc = Number(input.MAX_PAYMENT_USDC || LEAN_V0_MAX_PAYMENT_USDC);
  if (!Number.isFinite(maxPaymentUsdc) || maxPaymentUsdc <= 0 || maxPaymentUsdc > LEAN_V0_MAX_PAYMENT_USDC) {
    throw new NetworkPolicyError(`Lean v0 requires 0 < MAX_PAYMENT_USDC <= ${LEAN_V0_MAX_PAYMENT_USDC}`);
  }

  return { ...LEAN_V0_NETWORK, maxPaymentUsdc };
}

export function assertLeanV0Configuration() {
  return validateLeanV0Configuration({
    STELLAR_NETWORK: env.STELLAR_NETWORK,
    STELLAR_RPC_URL: env.STELLAR_RPC_URL,
    MAX_PAYMENT_USDC: env.MAX_PAYMENT_USDC
  });
}

export function assertLeanV0Feature(feature: LeanV0Feature): void {
  if (!LEAN_V0_FEATURES[feature]) throw new UnsupportedPolicyError(feature);
}

export function configuredAllowedAgentIds(raw = env.ALGORIA_ALLOWED_AGENT_IDS): Set<number> {
  if (!raw?.trim()) return new Set();
  const values = raw.split(',').map((value) => value.trim()).filter(Boolean);
  const ids = values.map(Number);
  if (ids.some((id) => !Number.isSafeInteger(id) || id < 0)) {
    throw new NetworkPolicyError('ALGORIA_ALLOWED_AGENT_IDS must contain comma-separated non-negative integers');
  }
  return new Set(ids);
}

function record(value: unknown): UnknownRecord {
  return typeof value === 'object' && value !== null ? value as UnknownRecord : {};
}

export interface OperatorServiceProfile {
  inputExample?: unknown;
  inputSchema?: Record<string, unknown>;
  endpoint?: string;
  description?: string;
  offered?: boolean;
}

/**
 * Stellar 8004 leaves `inputExample` optional, and the registered services that
 * actually run in production do not declare one, so nothing could be compiled
 * into a reviewable request. Because only operator-allowlisted identities are
 * eligible at all, the operator supplies the missing shape here. This is
 * operator-authored configuration, never agent-declared metadata.
 *
 * `endpoint` covers a second gap the registry allows: a registration may point
 * its service at a directory rather than at anything billable. One registered
 * router publishes a free catalogue listing hundreds of paid routes, so the
 * declared endpoint answers 200 with a price list and never charges, so a user
 * asking for work would receive the catalogue as their result. The operator
 * therefore names the route to invoke. The origin is still the agent's own
 * (enforced where the registration is read), so the on-chain identity keeps
 * vouching for the host; only the path narrows.
 *
 * `offered: false` withdraws a service the registration publishes. Allowlisting
 * an agent otherwise offers everything it declares, which is wrong for a router:
 * its catalogue and health endpoints are real and reachable but sell nothing, and
 * they answer to a description that makes them look like the work. Naming better
 * routes does not remove the worse ones, so the operator withdraws them.
 *
 * Keys are `<agentId>` for every service of an agent, or `<agentId>:<serviceName>`
 * for one service; the more specific key wins. A key carrying an `endpoint` whose
 * service name the registration does not publish declares an additional route.
 */
export function configuredServiceProfiles(
  raw = env.ALGORIA_SERVICE_PROFILES
): Map<string, OperatorServiceProfile> {
  const profiles = new Map<string, OperatorServiceProfile>();
  if (!raw?.trim()) return profiles;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new NetworkPolicyError('ALGORIA_SERVICE_PROFILES must be a JSON object');
  }
  for (const [key, value] of Object.entries(record(parsed))) {
    if (!/^\d+(:[\w-]{1,80})?$/.test(key)) {
      throw new NetworkPolicyError('ALGORIA_SERVICE_PROFILES keys must be "<agentId>" or "<agentId>:<serviceName>"');
    }
    const entry = record(value);
    const profile: OperatorServiceProfile = {};
    if (entry.inputExample !== undefined) profile.inputExample = entry.inputExample;
    if (entry.inputSchema !== undefined) profile.inputSchema = record(entry.inputSchema);
    if (entry.endpoint !== undefined) {
      // A bare `<agentId>` key applies to every service the agent publishes, so an
      // endpoint there would collapse them all onto one route. Only the specific
      // form can name a route.
      if (!key.includes(':')) {
        throw new NetworkPolicyError('ALGORIA_SERVICE_PROFILES endpoint requires an "<agentId>:<serviceName>" key');
      }
      if (typeof entry.endpoint !== 'string' || !URL.canParse(entry.endpoint) || new URL(entry.endpoint).protocol !== 'https:') {
        throw new NetworkPolicyError('ALGORIA_SERVICE_PROFILES endpoint must be an https URL');
      }
      profile.endpoint = entry.endpoint;
    }
    if (typeof entry.description === 'string' && entry.description.trim()) profile.description = entry.description;
    if (entry.offered === false) profile.offered = false;
    if (
      profile.inputExample === undefined && profile.inputSchema === undefined
      && profile.endpoint === undefined && profile.offered === undefined
    ) continue;
    profiles.set(key, profile);
  }
  return profiles;
}

export function assertLeanV0Selection(
  selection: unknown,
  allowedAgentIds = configuredAllowedAgentIds()
): void {
  const candidate = record(selection);
  if (candidate.source === 'x402-bazaar') {
    throw new UnsupportedPolicyError('bazaarRouting', 'Public Bazaar routing is outside lean v0');
  }
  if (candidate.source !== 'stellar8004') {
    throw new UnsupportedPolicyError('catalogSource', 'Lean v0 accepts only allowlisted Stellar 8004 services');
  }

  const agentId = Number(candidate.agent8004Id);
  if (!Number.isSafeInteger(agentId) || agentId < 0 || !allowedAgentIds.has(agentId)) {
    throw new UnsupportedPolicyError('agentAllowlist', 'The Stellar 8004 identity is not allowlisted for lean v0');
  }

  const protocols = Array.isArray(candidate.protocols) ? candidate.protocols.filter((value): value is string => typeof value === 'string') : [];
  if (protocols.includes('mcp')) throw new UnsupportedPolicyError('mcpExecution');
  if (protocols.includes('a2a')) throw new UnsupportedPolicyError('a2aExecution');
  if (protocols.includes('mpp')) throw new UnsupportedPolicyError('mppPayment');
  if (!protocols.includes('http')) {
    throw new UnsupportedPolicyError('httpExecution', 'Lean v0 services must expose HTTP invocation');
  }
  if (protocols.some((protocol) => !['http', 'x402'].includes(protocol))) {
    throw new UnsupportedPolicyError('executionProtocol', 'The service declares an unsupported lean v0 protocol');
  }

  const pricing = record(candidate.pricing);
  if (Object.keys(pricing).length > 0) {
    if (pricing.scheme !== 'exact' || pricing.network !== LEAN_V0_NETWORK.caip2 || pricing.asset !== LEAN_V0_NETWORK.usdcSac) {
      throw new UnsupportedPolicyError('paymentPolicy', `The declared price does not match exact ${ACTIVE_NETWORK_LABEL} USDC`);
    }
  }
}

export function policyFailure(error: unknown): { status: 501 | 503; body: { code: string; message: string } } | null {
  if (error instanceof UnsupportedPolicyError) {
    return { status: 501, body: { code: error.code, message: error.message } };
  }
  if (error instanceof NetworkPolicyError) {
    return { status: 503, body: { code: error.code, message: error.message } };
  }
  return null;
}
