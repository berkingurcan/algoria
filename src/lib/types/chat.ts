import type { CatalogResource, JsonSchema, StellarPaymentOption } from './catalog';

export type JobState =
  | 'routing'
  | 'awaiting-agent-selection'
  | 'needs-input'
  | 'awaiting-job-approval'
  | 'probing'
  | 'awaiting-payment'
  | 'signing'
  | 'executing'
  | 'payment-uncertain'
  | 'succeeded'
  | 'failed'
  | 'cancelled';

export interface JobCard {
  id: string;
  state: JobState;
  prompt: string;
  candidates?: CatalogResource[];
  selected?: CatalogResource;
  inputSchema?: JsonSchema;
  arguments?: Record<string, unknown>;
  correlationId?: string;
  warnings?: string[];
  missingFields?: string[];
  preparation?: {
    token: string;
    expiresAt: string;
    preview:
      | { kind: 'mcp'; endpoint: string; tool: string; arguments: Record<string, unknown> }
      | {
          kind: 'http';
          endpoint: string;
          method: 'GET' | 'POST';
          correlationId: string;
          arguments: Record<string, unknown>;
          body?: Record<string, unknown>;
          /** How the request shape was established: published by the service, narrowed by a probe, or guessed. */
          shape?: 'declared' | 'endpoint-validated' | 'inferred';
        };
  };
  payment?: StellarPaymentOption & {
    protocol: 'x402' | 'mpp';
    quoteId: string;
    expiresAt: string;
    paymentRequired: string;
    /** False when the service exposes no status lookup, so a lost result cannot be re-fetched. */
    recoverable?: boolean;
  };
  result?: { status: number; body: unknown; txHash?: string };
  /**
   * A reputation entry this wallet wrote about the agent. `submitted` is a real
   * outcome, not a transient one: the entry is on its way to the ledger but has
   * not been seen there yet, and saying so is more honest than showing it as
   * confirmed or as failed.
   */
  feedback?: {
    status: 'prepared' | 'submitting' | 'submitted' | 'confirmed' | 'failed';
    score?: number;
    tag?: string;
    txHash?: string | null;
  };
  error?: string;
}

export type MessageRole = 'user' | 'assistant' | 'system';
export type MessageKind = 'text' | 'job';

export interface ChatMessage {
  id: string;
  role: MessageRole;
  kind: MessageKind;
  text?: string;
  job?: JobCard;
  createdAt: string;
}

export interface ConversationSummary {
  id: string;
  title: string;
  updatedAt: string;
  expiresAt: string;
}

export type StreamEvent =
  | { type: 'message_delta'; delta: string }
  | { type: 'candidates'; job: JobCard }
  | { type: 'needs_input'; job: JobCard }
  | { type: 'job_state'; jobId: string; state: JobState }
  | { type: 'payment_required'; job: JobCard }
  | { type: 'result'; job: JobCard }
  | { type: 'error'; message: string; jobId?: string }
  | { type: 'done' };
