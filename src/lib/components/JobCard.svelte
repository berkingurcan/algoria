<script lang="ts">
  import {
    BadgeCheck,
    ChevronDown,
    Eye,
    LoaderCircle,
    Play,
    RotateCcw,
    Route,
    ShieldCheck,
    SlidersHorizontal,
    Sparkles,
    WalletCards,
    X,
    Zap
  } from '@lucide/svelte';
  import type { JobCard } from '$lib/types/chat';
  import AgentCandidate from './AgentCandidate.svelte';
  import { LEAN_V0_NETWORK } from '$lib/constants';
  import { useAlgoriaState } from '$lib/state/app.svelte';

  let { job }: { job: JobCard } = $props();
  const app = useAlgoriaState();

  // The registry stores whole steps, so the interface offers exactly those and
  // nothing between them; a slider would imply a precision the ledger does not
  // keep.
  const SCORES = [
    { value: 100, label: 'Excellent' },
    { value: 80, label: 'Good' },
    { value: 60, label: 'Mixed' },
    { value: 40, label: 'Poor' },
    { value: 20, label: 'Unusable' }
  ];
  let rating = $state<number | null>(null);
  const working = $derived(['routing', 'probing', 'signing', 'executing'].includes(job.state));
  const alternatives = $derived((job.candidates ?? []).filter((candidate) => candidate.key !== job.selected?.key));
  let alternativesOpen = $state(false);
  let editing = $state(false);
  let revisedPrompt = $state('');
  let missingDetail = $state('');
  let now = $state(Date.now());

  $effect(() => {
    if (!editing) revisedPrompt = job.prompt;
  });

  $effect(() => {
    if (job.state !== 'awaiting-payment' || !job.payment) return;
    const timer = setInterval(() => { now = Date.now(); }, 1_000);
    return () => clearInterval(timer);
  });

  const quoteRemainingMs = $derived(job.payment ? new Date(job.payment.expiresAt).getTime() - now : 0);
  const quoteExpired = $derived(Boolean(job.payment) && quoteRemainingMs <= 0);
  const showRecoveryId = $derived(Boolean(job.correlationId) && ['probing', 'awaiting-payment', 'executing', 'payment-uncertain', 'succeeded', 'failed'].includes(job.state));
  const canCheckStatus = $derived(job.state === 'payment-uncertain'
    || (['probing', 'executing'].includes(job.state) && Boolean(job.correlationId) && !app.jobInFlight(job.id)));

  function countdown(ms: number) {
    const total = Math.max(0, Math.ceil(ms / 1000));
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
  }

  function shortKey(value: string) {
    return `${value.slice(0, 6)}…${value.slice(-4)}`;
  }

  /** '/maxSentences' or '/fields/0' -> 'max sentences' */
  function fieldLabel(path: string) {
    const name = path.split('/').filter((part) => part && !/^\d+$/.test(part)).pop() ?? path;
    return name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').toLowerCase();
  }

  function statusLabel() {
    const labels: Partial<Record<JobCard['state'], string>> = {
      routing: 'Finding a match',
      'awaiting-agent-selection': 'Needs a choice',
      'awaiting-job-approval': app.auth ? 'Ready for review' : 'Wallet required',
      probing: job.preparation || job.correlationId ? 'Running approved request' : 'Preparing request',
      'awaiting-payment': quoteExpired ? 'Quote expired' : 'Payment approval',
      signing: 'Waiting for wallet',
      executing: 'Running',
      'payment-uncertain': 'Payment status unknown',
      succeeded: 'Complete',
      failed: 'Could not complete',
      cancelled: 'Cancelled',
      'needs-input': 'More detail needed'
    };
    return labels[job.state] ?? job.state.replaceAll('-', ' ');
  }

  function matchReason() {
    if (!job.selected) return '';
    return `Recommended from the allowlisted ${app.policy.network} services based on declared capability fit.`;
  }

  function readableResult(value: unknown): string | null {
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) {
      const text = value
        .map((item) => typeof item === 'object' && item !== null && 'text' in item && typeof item.text === 'string' ? item.text : null)
        .filter((item): item is string => Boolean(item))
        .join('\n\n');
      return text || null;
    }
    if (typeof value !== 'object' || value === null) return value === undefined ? null : String(value);
    for (const key of ['answer', 'text', 'content', 'output', 'result']) {
      const child = (value as Record<string, unknown>)[key];
      const text = readableResult(child);
      if (text) return text;
    }
    return null;
  }

  async function applyRevision() {
    if (!revisedPrompt.trim() || revisedPrompt.trim() === job.prompt) {
      editing = false;
      return;
    }
    await app.reviseProposal(job.id, revisedPrompt);
  }
</script>

<div class="job-card">
  <div class="job-card-header">
    {#if working}<LoaderCircle size={13} class="animate-spin" />{:else if job.state === 'succeeded'}<Sparkles size={13} />{:else}<Route size={13} strokeWidth={1.5} />{/if}
    <span class="job-title">{job.state === 'routing' ? 'Routing your request' : job.state === 'succeeded' ? 'Agent response' : 'Execution proposal'}</span>
    <span class:ready={job.state === 'awaiting-job-approval' && Boolean(app.auth)} class:succeeded={job.state === 'succeeded'} class:failed={job.state === 'failed'} class:awaiting-payment={job.state === 'awaiting-payment' || job.state === 'payment-uncertain' || (job.state === 'awaiting-job-approval' && !app.auth)} class="status">{statusLabel()}</span>
  </div>
  <div class="job-card-body">
    {#if job.state === 'routing'}
      <div class="routing-line"><span class="routing-pulse"></span><span>Finding an eligible allowlisted Stellar 8004 service…</span></div>
    {/if}

    {#if job.selected}
      <section class="proposal-match" aria-label="Recommended service">
        <div class="proposal-agent">
          <span class="agent-avatar">{job.selected.name.slice(0, 1).toUpperCase()}</span>
          <div class="proposal-identity">
            <div class="proposal-kicker">
              Recommended
              {#if job.selected.agent8004Id !== undefined}
                <span><BadgeCheck size={10} /> Stellar 8004</span>
              {:else}
                <span><BadgeCheck size={10} /> Stellar x402</span>
              {/if}
            </div>
            <strong>{job.selected.serviceName || job.selected.name}</strong>
            <small>{job.selected.name}</small>
          </div>
          <div class="proposal-price">
            <span>Catalog price</span>
            <strong>{#if job.selected.pricing}<Zap size={11} /> {job.selected.pricing.amountUsdc} USDC{:else}Live quote{/if}</strong>
          </div>
        </div>
        <p>{job.selected.description}</p>
        <div class="match-reason"><Sparkles size={11} /><span>{matchReason()}</span></div>
        <div class="proposal-meta">
          <span>{app.policy.network} · {job.selected.protocols.join(' · ') || 'protocol pending'}</span>
          <button type="button" onclick={() => app.inspectorResource = job.selected ?? null}><Eye size={11} /> Details</button>
        </div>
      </section>

      {#if alternatives.length}
        <div class="alternatives">
          <button type="button" class:open={alternativesOpen} class="alternatives-toggle" onclick={() => alternativesOpen = !alternativesOpen} aria-expanded={alternativesOpen}>
            <span>{alternatives.length} {alternatives.length === 1 ? 'alternative' : 'alternatives'}</span>
            <span>Compare only if you want another tradeoff <ChevronDown size={12} /></span>
          </button>
          {#if alternativesOpen}
            <div class="alternative-list">
              {#each alternatives as candidate (candidate.key)}
                <AgentCandidate resource={candidate} onclick={() => { alternativesOpen = false; app.selectCandidate(job.id, candidate); }} />
              {/each}
            </div>
          {/if}
        </div>
      {/if}
    {/if}

    {#if job.selected && job.state === 'awaiting-job-approval'}
      <div class="notice">
        <ShieldCheck size={11} class="inline mr-1" />
        {job.preparation
          ? 'Review the exact request below. If the service returns 402, payment still requires a separate wallet confirmation.'
          : app.auth
            ? 'Algoria will prepare the exact endpoint, tool, and arguments without running the agent.'
            : 'Connect a Stellar wallet to prepare and approve this request. No agent has run yet.'}
      </div>
      {#if job.preparation}
        <div class="request-preview">
          <div class="text-[10px] mono muted">{job.preparation.preview.kind === 'mcp' ? `MCP · ${job.preparation.preview.tool}` : job.preparation.preview.method}</div>
          <div class="endpoint mono">{job.preparation.preview.endpoint}</div>
          {#if job.preparation.preview.kind === 'http'}<div class="text-[9px] mono muted">Recovery · {job.preparation.preview.correlationId}</div>{/if}
          {#if job.preparation.preview.kind === 'http' && job.preparation.preview.shape === 'inferred'}
            <div class="text-[9px] muted">This service publishes no usable example, and it answers the same way whether or not a request fits, so the call below was derived from your task. Check it before paying. If it is wrong, the service can still charge.</div>
          {:else if job.preparation.preview.kind === 'http' && job.preparation.preview.shape === 'endpoint-validated'}
            <div class="text-[9px] muted">The service refused the request its own registration describes, so Algoria adjusted it to a form the service accepts.</div>
          {/if}
          <pre class="endpoint">{JSON.stringify(job.preparation.preview.arguments, null, 2)}</pre>
        </div>
      {/if}
      {#if editing}
        <div class="proposal-editor">
          <label for={`proposal-${job.id}`}>Adjust the outcome, budget, format, or constraints</label>
          <textarea id={`proposal-${job.id}`} bind:value={revisedPrompt} rows="3"></textarea>
          <div class="job-actions">
            <button type="button" class="secondary-button" onclick={() => { revisedPrompt = job.prompt; editing = false; }}>Keep current</button>
            <button type="button" class="primary-button" disabled={!revisedPrompt.trim() || app.busy} onclick={applyRevision}>Update proposal</button>
          </div>
        </div>
      {/if}
      <div class="job-actions">
        <button type="button" class="secondary-button" onclick={() => app.cancelJob(job.id)}><X size={12} /> Cancel</button>
        <button type="button" class="secondary-button" onclick={() => editing = !editing}><SlidersHorizontal size={12} /> Adjust</button>
        {#if job.preparation}
          <button type="button" class="primary-button" onclick={() => app.approveJob(job.id)}><Play size={12} /> {job.selected.pricing ? `Run · ${job.selected.pricing.amountUsdc} USDC listed` : 'Approve & run'}</button>
        {:else}
          <button type="button" class="primary-button" disabled={!app.auth} onclick={() => app.prepareJob(job.id)}><ShieldCheck size={12} /> {app.auth ? 'Prepare exact request' : 'Connect wallet first'}</button>
        {/if}
      </div>
    {/if}

    {#if job.payment}
      {#if job.state === 'awaiting-payment'}
        <div class="notice">
          <WalletCards size={11} class="inline mr-1" />
          Separate payment approval. Signing authorizes exactly the quote below, once.
        </div>
        <div class="request-preview" aria-label="Exact payment quote">
          <div class="text-[10px] mono muted">x402 exact · {job.payment.network}</div>
          <div class="endpoint"><strong>{job.payment.amountUsdc} {app.policy.asset}</strong> → {job.payment.payTo}</div>
          <div class="text-[9px] mono muted">Asset · {shortKey(job.payment.asset)} ({app.policy.asset} SAC)</div>
          <div class="text-[9px] mono muted">Quote · {job.payment.quoteId}</div>
          {#if !quoteExpired}
            <div class="text-[10px] mono muted">Quote expires in {countdown(quoteRemainingMs)}</div>
          {/if}
        </div>
        {#if job.payment.recoverable === false}
          <div class="notice">
            This service offers no status lookup. If its response is lost, Algoria can still confirm on the ledger
            whether the payment settled, but cannot re-fetch the result.
          </div>
        {/if}
        {#if quoteExpired}
          <div class="notice error-notice">The payment quote expired before signing. Request a new quote to continue. Nothing was paid.</div>
        {/if}
        <div class="job-actions">
          <button type="button" class="secondary-button" onclick={() => app.cancelJob(job.id)}><X size={12} /> Cancel</button>
          {#if quoteExpired}
            <button type="button" class="primary-button" disabled={app.busy} onclick={() => app.requestNewQuote(job.id)}><RotateCcw size={12} /> Request new quote</button>
          {:else}
            <button type="button" class="primary-button" onclick={() => app.payJob(job.id)}><WalletCards size={12} /> Review & sign</button>
          {/if}
        </div>
      {:else if job.state === 'signing' || job.state === 'executing'}
        <div class="notice">
          Signing exact payment: <strong>{job.payment.amountUsdc} {app.policy.asset}</strong> to <span class="mono">{shortKey(job.payment.payTo)}</span>. Nothing else is authorized.
        </div>
      {/if}
    {/if}

    {#if job.result}
      {@const resultText = readableResult(job.result.body)}
      {#if resultText}<div class="result-content">{resultText}</div>{/if}
      {#if !resultText || typeof job.result.body === 'object'}
        <details class="result-details" open={!resultText}>
          <summary>{resultText ? 'Structured response' : 'Response data'}</summary>
          <pre class="endpoint">{JSON.stringify(job.result.body, null, 2)}</pre>
        </details>
      {/if}
      {#if job.result.txHash && !job.feedback}
        <!-- Offered only where a payment settled: the registry counts unique
             paying clients, and an entry no payment stands behind is the noise
             it exists to keep out. -->
        <div class="rating">
          <span class="text-[10px] muted">Rate this agent on Stellar 8004</span>
          <div class="rating-row">
            {#each SCORES as option}
              <button
                type="button"
                class="rating-option"
                aria-pressed={rating === option.value}
                onclick={() => rating = option.value}
              >{option.label}</button>
            {/each}
          </div>
          {#if rating !== null}
            <button
              type="button"
              class="rating-submit"
              onclick={() => app.submitFeedback(job.id, rating!, rating! >= 80 ? 'helpful' : rating! >= 60 ? 'mixed' : 'unhelpful')}
            >Sign and publish rating</button>
            <span class="text-[9px] muted">Your wallet signs this entry; it costs a small XLM network fee.</span>
          {/if}
        </div>
      {/if}
      {#if job.feedback}
        <div class="text-[9px] mono muted">
          Rating · {job.feedback.status}{#if job.feedback.txHash} ·
            <a
              class="underline underline-offset-2 hover:opacity-70"
              href="https://stellar.expert/explorer/{LEAN_V0_NETWORK.explorerNetwork}/tx/{job.feedback.txHash}"
              target="_blank"
              rel="noopener noreferrer"
            >{job.feedback.txHash}</a>
          {/if}
        </div>
      {/if}
      {#if job.result.txHash}
        <!-- Real value moved, so the receipt has to be checkable by someone who
             does not take our word for it. The explorer network comes from the
             active profile; a link to the wrong chain would read as a missing
             transaction and look exactly like a loss. -->
        <div class="text-[9px] mono muted">
          Settlement tx · <a
            class="underline underline-offset-2 hover:opacity-70"
            href="https://stellar.expert/explorer/{LEAN_V0_NETWORK.explorerNetwork}/tx/{job.result.txHash}"
            target="_blank"
            rel="noopener noreferrer"
          >{job.result.txHash}</a>
        </div>
      {/if}
    {/if}

    {#if showRecoveryId}
      <div class="text-[9px] mono muted">Recovery · {job.correlationId}</div>
    {/if}

    {#if job.warnings?.length}
      <div class="text-[9px] muted">{job.warnings.join(' ')}</div>
    {/if}

    {#if job.state === 'needs-input'}
      <div class="notice">
        {#if job.missingFields?.length}
          This service still needs {job.missingFields.map(fieldLabel).join(', ')}. Add the detail below; nothing has run and no payment was requested.
        {:else}
          {job.error ?? 'More detail is needed before this request can run.'}
        {/if}
      </div>
      <div class="proposal-editor">
        <label for={`missing-${job.id}`}>Add the missing detail</label>
        <textarea id={`missing-${job.id}`} bind:value={missingDetail} rows="3"
          placeholder={job.missingFields?.length ? `e.g. ${fieldLabel(job.missingFields[0])}: …` : 'Add the detail this service needs…'}></textarea>
        <div class="job-actions">
          <button type="button" class="secondary-button" onclick={() => app.sendPrompt(job.prompt)}><RotateCcw size={12} /> Start over</button>
          <button type="button" class="primary-button" disabled={!missingDetail.trim() || app.jobInFlight(job.id)}
            onclick={() => { const detail = missingDetail; missingDetail = ''; app.addMissingDetail(job.id, detail); }}>
            <ShieldCheck size={12} /> Add detail & prepare
          </button>
        </div>
      </div>
    {:else if job.error}
      <div class="notice error-notice">{job.error}</div>
      {#if job.state === 'failed'}
        <div class="job-actions"><button type="button" class="secondary-button" onclick={() => app.sendPrompt(job.prompt)}><RotateCcw size={12} /> Try again</button></div>
      {/if}
    {/if}

    {#if canCheckStatus}
      <div class="job-actions">
        <button type="button" class="secondary-button" disabled={app.jobRecovering(job.id)} onclick={() => app.recoverJob(job.id)}>
          {#if app.jobRecovering(job.id)}<LoaderCircle size={12} class="animate-spin" />{:else}<RotateCcw size={12} />{/if}
          Check status
        </button>
      </div>
    {/if}
  </div>
</div>
