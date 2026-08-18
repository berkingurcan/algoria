<script lang="ts">
  import { BadgeCheck, CircleAlert, ChevronRight, Zap } from '@lucide/svelte';
  import type { CatalogResource } from '$lib/types/catalog';

  let { resource, selected = false, onclick = () => {} }: {
    resource: CatalogResource;
    selected?: boolean;
    onclick?: () => void;
  } = $props();

  const sourceLabel = $derived(resource.source === 'stellar8004' ? '8004' : 'Bazaar');
  const available = $derived(resource.executionStatus === 'ready');

  function endpointLabel(endpoint: string) {
    if (!endpoint) return '';
    try {
      const url = new URL(endpoint);
      const segment = url.pathname.split('/').filter(Boolean).at(-1)?.replaceAll('-', ' ');
      return segment || url.hostname;
    } catch {
      return '';
    }
  }

  function capabilityLabel() {
    const serviceName = resource.serviceName?.trim();
    if (serviceName && serviceName.toLowerCase() !== resource.name.toLowerCase()) return serviceName;
    const firstThought = resource.description.split(/(?:\.| — | - )/)[0]?.trim();
    if (firstThought && firstThought.length <= 76) return firstThought;
    return endpointLabel(resource.endpoint) || resource.name;
  }

  const capability = $derived(capabilityLabel());
</script>

<button type="button" class:selected class="candidate" {onclick}>
  <span class="agent-avatar">{resource.name.slice(0, 1).toUpperCase()}</span>
  <span class="candidate-main">
    <span class="candidate-provider">
      {resource.name}
      {#if resource.agent8004Id !== undefined}<BadgeCheck size={11} strokeWidth={1.8} aria-label="On-chain identity" />{/if}
      <span class="candidate-source">{sourceLabel}</span>
    </span>
    <span class="candidate-name">{capability}</span>
    <span class="candidate-desc">{resource.description}</span>
    <span class="chips">
      {#each resource.protocols as protocol}<span class="chip">{protocol}</span>{/each}
      {#if available}<span class="chip success">ready</span>{:else}<span class="chip warning"><CircleAlert size={8} /> {resource.executionStatus}</span>{/if}
      {#if resource.evidence.reputationStatus !== 'not-applicable'}<span class="chip warning">reputation {resource.evidence.reputationStatus}</span>{/if}
    </span>
  </span>
  <span class="candidate-price">
    {#if resource.pricing}<Zap size={10} class="inline" /> {resource.pricing.amountUsdc} USDC{:else}n/a{/if}
    <ChevronRight size={14} class="candidate-arrow" />
  </span>
</button>
