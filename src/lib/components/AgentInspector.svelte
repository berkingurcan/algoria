<script lang="ts">
  import { BadgeCheck, CircleAlert, ExternalLink, Shield, Zap, X } from '@lucide/svelte';
  import { useAlgoriaState } from '$lib/state/app.svelte';

  const app = useAlgoriaState();

  function resourceTitle() {
    const resource = app.inspectorResource;
    if (!resource) return '';
    if (resource.serviceName && resource.serviceName.toLowerCase() !== resource.name.toLowerCase()) return resource.serviceName;
    const firstThought = resource.description.split(/(?:\.| — | - )/)[0]?.trim();
    return firstThought && firstThought.length <= 58 ? firstThought : resource.name;
  }
</script>

{#if app.inspectorResource}
  {@const resource = app.inspectorResource}
  <aside class="inspector">
    <div class="inspector-header">
      <div class="agent-avatar">{resource.name.slice(0, 1).toUpperCase()}</div>
      <div class="min-w-0 flex-1"><div class="inspector-provider">{resource.name}</div><h2 class="display">{resourceTitle()}</h2></div>
      <button type="button" class="icon-button" aria-label="Close inspector" onclick={() => app.inspectorResource = null}><X size={14} /></button>
    </div>
    <div class:ready={resource.executionStatus === 'ready'} class="inspector-status">
      {#if resource.executionStatus === 'ready'}<span class="live-dot"></span>{:else}<CircleAlert size={11} />{/if}
      {resource.executionStatus.replaceAll('-', ' ')}
    </div>
    <p class="inspector-description">{resource.description}</p>

    <section class="inspector-section">
      <div class="inspector-section-title"><Shield size={12} /> Trust evidence</div>
      <div class="metric-row"><span>Identity</span><strong>{resource.evidence.identity === 'on-chain-8004' ? 'On-chain 8004' : 'Bazaar listing'} {#if resource.agent8004Id !== undefined}<BadgeCheck size={11} />{/if}</strong></div>
      <div class="metric-row"><span>Reputation</span><strong>{resource.evidence.reputationStatus}</strong></div>
      {#if resource.evidence.declaredScore !== undefined}<div class="metric-row"><span>Declared score</span><strong>{resource.evidence.declaredScore.toFixed(2)} / 100</strong></div>{/if}
      {#if resource.evidence.feedbackCount !== undefined}<div class="metric-row"><span>Feedback rows</span><strong>{resource.evidence.feedbackCount}</strong></div>{/if}
      {#if resource.evidence.qualityCalls30d !== undefined}<div class="metric-row"><span>Bazaar calls · 30d</span><strong>{resource.evidence.qualityCalls30d}</strong></div>{/if}
      <div class="chips">{#each resource.evidence.labels as label}<span class="chip warning">{label}</span>{/each}</div>
    </section>

    <section class="inspector-section">
      <div class="inspector-section-title"><Zap size={12} /> Execution</div>
      <div class="metric-row"><span>Status</span><strong>{resource.executionStatus}</strong></div>
      <div class="metric-row"><span>Protocols</span><strong>{resource.protocols.join(', ') || 'none'}</strong></div>
      <div class="metric-row"><span>Catalog price</span><strong class="price-text">{resource.pricing ? `${resource.pricing.amountUsdc} USDC` : 'Live quote at execution'}</strong></div>
      <div class="endpoint">{resource.endpoint || 'No callable endpoint declared.'}</div>
    </section>

    {#if resource.agent8004Id !== undefined}
      <a class="secondary-button mt-4 w-full" href={`https://stellar8004.com/agents/${resource.agent8004Id}`} target="_blank" rel="noreferrer">View 8004 identity <ExternalLink size={11} /></a>
    {/if}
  </aside>
{/if}
