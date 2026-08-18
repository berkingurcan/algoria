export type CatalogSource = 'stellar8004' | 'x402-bazaar';
export type ExecutionProtocol = 'mcp' | 'http' | 'x402' | 'mpp' | 'a2a';
export type ExecutionStatus =
  | 'ready'
  | 'missing-schema'
  | 'unreachable'
  | 'unsupported-protocol'
  | 'unsupported-payment'
  | 'payment-over-cap'
  | 'wallet-incompatible';

export type JsonSchema = Record<string, unknown>;

export interface StellarPaymentOption {
  scheme: string;
  network: string;
  asset: string;
  amountAtomic: string;
  amountUsdc: string;
  payTo: string;
  maxTimeoutSeconds?: number;
}

export interface TrustEvidence {
  identity: 'on-chain-8004' | 'bazaar-only';
  reputationStatus: 'declared' | 'unavailable' | 'not-applicable';
  declaredScore?: number;
  feedbackCount?: number;
  uniqueClients?: number;
  qualityCalls30d?: number;
  qualityPayers30d?: number;
  labels: string[];
}

export interface CatalogResource {
  key: string;
  source: CatalogSource;
  agent8004Id?: number;
  name: string;
  description: string;
  endpoint: string;
  protocols: ExecutionProtocol[];
  inputSchema?: JsonSchema;
  inputExample?: unknown;
  pricing?: StellarPaymentOption;
  evidence: TrustEvidence;
  executionStatus: ExecutionStatus;
  updatedAt?: string;
  serviceName?: string;
  rawSourceIds: string[];
}

export interface CatalogSearchResponse {
  query: string;
  resources: CatalogResource[];
  partial: boolean;
  warnings: string[];
  sources: Array<{ source: CatalogSource; ok: boolean; latencyMs: number; error?: string }>;
}

export type RouterResponse =
  | ({ kind: 'agent-route' } & CatalogSearchResponse)
  | { kind: 'conversation' | 'no-match'; query: string; message: string };
