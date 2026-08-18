import { getContext, setContext } from 'svelte';
import type { CatalogResource, RouterResponse } from '$lib/types/catalog';
import type { ChatMessage, ConversationSummary, JobCard } from '$lib/types/chat';
import { ACTIVE_ASSET_LABEL, ACTIVE_NETWORK_IS_MAINNET, ACTIVE_NETWORK_LABEL, LEAN_V0_MAX_PAYMENT_USDC } from '$lib/constants';

const APP_STATE = Symbol('algoria-app-state');

export interface InitialState {
  auth: { userId: string; walletAddress: string } | null;
  conversations?: ConversationSummary[];
  messages?: ChatMessage[];
  policy?: DeploymentPolicy;
  suggestions?: Suggestion[];
}

/**
 * One thing this deployment can actually do, taken from the allowlisted
 * catalogue. The welcome screen used to name three fixed capabilities, which
 * were the controlled test provider's, so the mainnet deployment, which has
 * no such provider, opened by offering work it could not perform.
 */
export interface Suggestion {
  label: string;
  detail: string;
  prompt: string;
}

/**
 * What this deployment tells the user about itself. The interface quotes the
 * network and the cap as promises, so both are read from the server that
 * enforces them rather than written into the markup, where they would quietly
 * keep describing testnet after a cutover.
 */
export interface DeploymentPolicy {
  network: string;
  asset: string;
  isMainnet: boolean;
  maxPaymentUsdc: number;
}

export class AlgoriaState {
  auth = $state<InitialState['auth']>(null);
  suggestions = $state<Suggestion[]>([]);
  policy = $state<DeploymentPolicy>({
    network: ACTIVE_NETWORK_LABEL, asset: ACTIVE_ASSET_LABEL,
    isMainnet: ACTIVE_NETWORK_IS_MAINNET, maxPaymentUsdc: LEAN_V0_MAX_PAYMENT_USDC
  });
  conversations = $state<ConversationSummary[]>([]);
  activeConversationId = $state<string | null>(null);
  messages = $state<ChatMessage[]>([]);
  sidebarOpen = $state(false);
  inspectorResource = $state<CatalogResource | null>(null);
  busy = $state(false);
  error = $state<string | null>(null);
  private inFlight = $state<Record<string, boolean>>({});

  constructor(initial: InitialState) {
    this.auth = initial.auth;
    if (initial.policy) this.policy = initial.policy;
    this.suggestions = initial.suggestions ?? [];
    this.conversations = initial.conversations ?? [];
    this.messages = initial.messages ?? [];
    this.activeConversationId = this.conversations[0]?.id ?? null;
  }

  newConversation() {
    this.activeConversationId = null;
    this.messages = [];
    this.inspectorResource = null;
    this.sidebarOpen = false;
  }

  async openConversation(id: string) {
    this.activeConversationId = id;
    this.sidebarOpen = false;
    this.error = null;
    try {
      const response = await fetch(`/api/conversations/${id}`);
      if (!response.ok) throw new Error('Conversation could not be loaded.');
      const body = await response.json();
      this.messages = body.messages ?? [];
    } catch (error) {
      this.error = error instanceof Error ? error.message : 'Conversation could not be loaded.';
    }
  }

  async sendPrompt(prompt: string) {
    const text = prompt.trim();
    if (!text || this.busy) return;
    this.busy = true;
    this.error = null;
    const now = new Date().toISOString();
    this.messages = [...this.messages, {
      id: crypto.randomUUID(), role: 'user', kind: 'text', text, createdAt: now
    }];
    const jobId = crypto.randomUUID();
    const loadingJob: JobCard = { id: jobId, state: 'routing', prompt: text };
    this.messages = [...this.messages, {
      id: crypto.randomUUID(), role: 'assistant', kind: 'job', job: loadingJob, createdAt: now
    }];
    try {
      const response = await fetch('/api/router', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: text })
      });
      if (!response.ok) throw new Error('Agent routing is unavailable.');
      const result = await response.json() as RouterResponse;
      if (result.kind !== 'agent-route') {
        this.replaceJobWithText(jobId, result.message);
        return;
      }
      const candidates = result.resources.slice(0, 3);
      const recommended = candidates.find((candidate) => candidate.executionStatus === 'ready') ?? candidates[0];
      this.updateJob(jobId, {
        ...loadingJob,
        state: recommended?.executionStatus === 'ready' ? 'awaiting-job-approval' : 'failed',
        candidates,
        selected: recommended,
        warnings: result.warnings?.length ? result.warnings : undefined,
        error: candidates.length === 0
          ? 'No allowlisted Stellar 8004 service matched this task. No external service was called.'
          : recommended?.executionStatus !== 'ready'
            ? `Algoria found related services, but none can run safely right now (${recommended?.executionStatus.replaceAll('-', ' ')}).`
            : undefined
      });
      if (recommended?.executionStatus === 'ready' && this.auth) await this.prepareJob(jobId);
    } catch (error) {
      this.updateJob(jobId, { ...loadingJob, state: 'failed', error: error instanceof Error ? error.message : 'Routing failed.' });
    } finally {
      this.busy = false;
    }
  }

  async selectCandidate(jobId: string, resource: CatalogResource) {
    this.updateJobBy(jobId, (job) => ({
      ...job,
      selected: resource,
      arguments: undefined,
      preparation: undefined,
      payment: undefined,
      result: undefined,
      state: resource.executionStatus === 'ready' ? 'awaiting-job-approval' : 'failed',
      error: resource.executionStatus === 'ready' ? undefined : `This service is ${resource.executionStatus.replaceAll('-', ' ')}.`
    }));
    if (resource.executionStatus === 'ready' && this.auth) await this.prepareJob(jobId);
  }

  /**
   * Writes a reputation entry about the agent that did the work. The registry
   * counts unique paying clients, so this is offered only where a payment
   * settled. The entry is signed by the user's own wallet, because the
   * contract records feedback from its caller and Algoria holds no key that
   * could speak for them.
   */
  async submitFeedback(jobId: string, score: number, tag1: string) {
    if (!this.auth) {
      this.error = 'Connect a wallet before rating an agent.';
      return;
    }
    if (!this.beginJobWork(jobId)) return;
    this.error = null;
    try {
      const prepared = await fetch(`/api/jobs/${jobId}/feedback`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ score, tag1 })
      });
      const preparation = await prepared.json();
      if (!prepared.ok) throw new Error(preparation.message || 'The rating could not be prepared.');

      const { signFeedbackTransaction } = await import('$lib/client/payments');
      const signed = await signFeedbackTransaction(
        preparation.transaction, preparation.networkPassphrase, this.auth.walletAddress
      );

      const sent = await fetch(`/api/jobs/${jobId}/feedback`, {
        method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ transaction: signed })
      });
      const body = await sent.json();
      if (!sent.ok) throw new Error(body.message || 'The rating could not be submitted.');
      this.updateJobBy(jobId, (job) => ({ ...job, feedback: body.feedback }));
    } catch (error) {
      this.error = error instanceof Error ? error.message : 'The rating could not be submitted.';
    } finally {
      this.endJobWork(jobId);
    }
  }

  async reviseProposal(jobId: string, prompt: string) {
    const text = prompt.trim();
    if (!text || this.busy) return;
    this.updateJobBy(jobId, (job) => ({ ...job, state: 'cancelled' }));
    await this.sendPrompt(text);
  }

  async prepareJob(jobId: string) {
    if (!this.auth) {
      this.error = 'Connect and verify a Stellar wallet before preparing an agent request.';
      return;
    }
    const job = this.findJob(jobId);
    if (!job?.selected) return;
    if (!this.beginJobWork(jobId)) return;
    this.updateJobBy(jobId, (item) => ({ ...item, state: 'probing', error: undefined }));
    try {
      const response = await fetch('/api/jobs/prepare', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: job.prompt, resource: job.selected })
      });
      const body = await response.json();
      if (!response.ok) {
        this.updateJobBy(jobId, (item) => ({
          ...item,
          state: response.status === 422 ? 'needs-input' : 'failed',
          missingFields: response.status === 422 && Array.isArray(body.missing) ? body.missing : undefined,
          error: body.message || 'The exact request could not be prepared.'
        }));
        return;
      }
      this.updateJobBy(jobId, (item) => ({
        ...item,
        state: 'awaiting-job-approval',
        missingFields: undefined,
        arguments: body.arguments,
        preparation: { token: body.token, expiresAt: body.expiresAt, preview: body.preview }
      }));
    } catch (error) {
      this.updateJobBy(jobId, (item) => ({
        ...item,
        state: 'failed',
        error: error instanceof Error ? error.message : 'The exact request could not be prepared.'
      }));
    } finally {
      this.endJobWork(jobId);
    }
  }

  async approveJob(jobId: string) {
    if (!this.auth) {
      this.error = 'Connect and verify a Stellar wallet before running an agent.';
      return;
    }
    const selectedJob = this.findJob(jobId);
    if (!selectedJob?.preparation) {
      await this.prepareJob(jobId);
      return;
    }
    if (!this.beginJobWork(jobId)) return;
    this.updateJobBy(jobId, (job) => ({ ...job, state: 'probing' }));
    try {
      const job = this.findJob(jobId);
      const response = await fetch('/api/jobs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          conversationId: this.activeConversationId,
          prompt: job?.prompt,
          resource: job?.selected,
          preparationToken: job?.preparation?.token
        })
      });
      const body = await response.json();
      if (body.job) {
        this.replaceJobId(jobId, body.job);
        if (body.conversation) {
          this.activeConversationId = body.conversation.id;
          this.conversations = [body.conversation, ...this.conversations.filter((item) => item.id !== body.conversation.id)];
        }
        if (!response.ok && body.message) this.error = body.message;
        return;
      }
      if (!response.ok) throw new Error(body.message || 'Agent job could not be started.');
      throw new Error('Agent job returned no state.');
    } catch (error) {
      this.updateJobBy(jobId, (job) => ({ ...job, state: 'failed', error: error instanceof Error ? error.message : 'Agent job failed.' }));
    } finally {
      this.endJobWork(jobId);
    }
  }

  async payJob(jobId: string) {
    if (!this.auth) {
      this.error = 'Connect and verify the Stellar wallet before paying.';
      return;
    }
    const job = this.findJob(jobId);
    if (!job?.payment || job.state !== 'awaiting-payment') return;
    if (!this.beginJobWork(jobId)) return;
    this.updateJobBy(jobId, (item) => ({ ...item, state: 'signing', error: undefined }));
    let submitted = false;
    try {
      const { createPaymentCredential } = await import('$lib/client/payments');
      const credential = await createPaymentCredential(job, this.auth.walletAddress);
      this.updateJobBy(jobId, (item) => ({ ...item, state: 'executing' }));
      submitted = true;
      const response = await fetch(`/api/jobs/${jobId}/payment`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ credential })
      });
      const body = await response.json();
      if (body.job) {
        this.updateJob(jobId, body.job);
        if (body.message) this.error = body.message;
        return;
      }
      if (!response.ok) {
        // The server refused before claiming the quote (expired, replaced, already claimed).
        // The authoritative row knows the real state; never guess payment-uncertain here.
        const synced = await this.refreshJob(jobId);
        if (body.message) this.error = body.message;
        if (!synced) throw new Error(body.message || 'Payment could not be settled.');
        return;
      }
      throw new Error('Payment endpoint returned no job state.');
    } catch (error) {
      if (submitted) {
        await this.reconcileAfterAmbiguousPayment(jobId);
      } else {
        this.updateJobBy(jobId, (item) => ({
          ...item,
          state: 'awaiting-payment',
          error: error instanceof Error ? error.message : 'Payment signing failed.'
        }));
      }
    } finally {
      this.endJobWork(jobId);
    }
  }

  /** The signed payment left the browser but no outcome arrived; ask the server what really happened. */
  private async reconcileAfterAmbiguousPayment(jobId: string) {
    const synced = await this.refreshJob(jobId);
    if (synced && ['executing', 'payment-uncertain'].includes(synced.state)) await this.recoverJob(jobId);
    const current = this.findJob(jobId);
    if (!current || ['signing', 'executing'].includes(current.state)) {
      this.updateJobBy(jobId, (item) => ({
        ...item,
        state: 'payment-uncertain',
        error: 'The signed payment was submitted, but its final status could not be confirmed. Do not pay again; use Check status to re-verify.'
      }));
    }
  }

  async refreshJob(jobId: string): Promise<JobCard | null> {
    try {
      const response = await fetch(`/api/jobs/${jobId}`);
      if (!response.ok) return null;
      const body = await response.json();
      if (!body.job) return null;
      this.updateJob(jobId, body.job);
      return body.job as JobCard;
    } catch {
      return null;
    }
  }

  async recoverJob(jobId: string) {
    if (!this.beginJobWork(`recover:${jobId}`)) return;
    try {
      const response = await fetch(`/api/jobs/${jobId}/recover`, { method: 'POST' });
      const body = await response.json().catch(() => ({}));
      if (body.job) {
        this.updateJob(jobId, body.job);
        if (body.message) this.error = body.message;
        return;
      }
      this.error = body.message || 'The job status could not be checked. Try again shortly.';
    } catch {
      this.error = 'The job status could not be checked. Try again shortly.';
    } finally {
      this.endJobWork(`recover:${jobId}`);
    }
  }

  /** Append the detail the compiler said was missing, then re-prepare the same service. */
  async addMissingDetail(jobId: string, detail: string) {
    const text = detail.trim();
    const job = this.findJob(jobId);
    if (!text || !job?.selected) return;
    this.updateJobBy(jobId, (item) => ({
      ...item,
      prompt: `${item.prompt}\n\n${text}`,
      error: undefined,
      missingFields: undefined
    }));
    await this.prepareJob(jobId);
  }

  async requestNewQuote(jobId: string) {
    const job = this.findJob(jobId);
    if (!job) return;
    try {
      await fetch(`/api/jobs/${jobId}/cancel`, { method: 'POST' });
    } catch { /* best effort: the expired quote may already be closed server-side */ }
    this.updateJobBy(jobId, (item) => ({ ...item, state: 'cancelled', error: undefined }));
    await this.sendPrompt(job.prompt);
  }

  jobInFlight(jobId: string) {
    return Boolean(this.inFlight[jobId]);
  }

  jobRecovering(jobId: string) {
    return Boolean(this.inFlight[`recover:${jobId}`]);
  }

  private beginJobWork(key: string): boolean {
    if (this.inFlight[key]) return false;
    this.inFlight[key] = true;
    return true;
  }

  private endJobWork(key: string) {
    delete this.inFlight[key];
  }

  async cancelJob(jobId: string) {
    const job = this.findJob(jobId);
    if (job?.state !== 'awaiting-payment') {
      this.updateJobBy(jobId, (item) => ({ ...item, state: 'cancelled' }));
      return;
    }
    if (!this.beginJobWork(jobId)) return;
    try {
      const response = await fetch(`/api/jobs/${jobId}/cancel`, { method: 'POST' });
      const body = await response.json();
      if (!response.ok || !body.job) throw new Error(body.message || 'The payment quote could not be cancelled.');
      this.updateJob(jobId, body.job);
    } catch (error) {
      this.error = error instanceof Error ? error.message : 'The payment quote could not be cancelled.';
    } finally {
      this.endJobWork(jobId);
    }
  }

  setAuth(auth: InitialState['auth']) {
    this.auth = auth;
    if (!auth) this.conversations = [];
  }

  async refreshConversations() {
    if (!this.auth) return;
    const response = await fetch('/api/conversations');
    if (!response.ok) return;
    const body = await response.json();
    this.conversations = body.conversations ?? [];
  }

  private findJob(jobId: string) {
    return this.messages.find((message) => message.job?.id === jobId)?.job;
  }

  private updateJob(jobId: string, next: JobCard) {
    this.messages = this.messages.map((message) => message.job?.id === jobId ? { ...message, job: next } : message);
  }

  private updateJobBy(jobId: string, update: (job: JobCard) => JobCard) {
    const current = this.findJob(jobId);
    if (current) this.updateJob(jobId, update(current));
  }

  private replaceJobId(localId: string, next: JobCard) {
    this.messages = this.messages.map((message) => message.job?.id === localId ? { ...message, job: next } : message);
  }

  private replaceJobWithText(jobId: string, text: string) {
    this.messages = this.messages.map((message) => message.job?.id === jobId
      ? { ...message, kind: 'text', text, job: undefined }
      : message);
  }
}

export function provideAlgoriaState(initial: InitialState) {
  const state = new AlgoriaState(initial);
  setContext(APP_STATE, state);
  return state;
}

export function useAlgoriaState() {
  return getContext<AlgoriaState>(APP_STATE);
}
