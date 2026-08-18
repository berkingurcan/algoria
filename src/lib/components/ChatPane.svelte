<script lang="ts">
  import { ArrowUp, ArrowUpRight, ShieldCheck } from '@lucide/svelte';
  import { tick } from 'svelte';
  import { useAlgoriaState } from '$lib/state/app.svelte';
  import JobCard from './JobCard.svelte';

  const app = useAlgoriaState();
  let prompt = $state('');
  let textarea: HTMLTextAreaElement;
  let scroll: HTMLDivElement;


  async function send(value = prompt) {
    if (!value.trim() || app.busy) return;
    prompt = '';
    await app.sendPrompt(value);
    await tick();
    scroll?.scrollTo({ top: scroll.scrollHeight, behavior: 'smooth' });
    resize();
  }

  function keydown(event: KeyboardEvent) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      send();
    }
  }

  function resize() {
    if (!textarea) return;
    textarea.style.height = 'auto';
    textarea.style.height = `${Math.min(textarea.scrollHeight, 180)}px`;
  }
</script>

<div class="message-scroll" bind:this={scroll}>
  <div class="message-stack">
    {#if app.messages.length === 0}
      <section class="welcome">
        <div class="welcome-copy">
          <div class="welcome-eyebrow">{app.policy.network} execution</div>
          <h1 class="display">What should Algoria do?</h1>
          <p>Describe one bounded task. Algoria recommends an allowlisted 8004 service and shows the exact request before anything runs.</p>
        </div>
        {#if app.suggestions.length}
        <div class="suggestion-grid">
          {#each app.suggestions as suggestion}
            <button type="button" class="suggestion" onclick={() => send(suggestion.prompt)}>
              <span class="suggestion-copy"><strong>{suggestion.label}</strong><small>{suggestion.detail}</small></span>
              <ArrowUpRight size={14} class="suggestion-arrow" />
            </button>
          {/each}
        </div>
        {/if}
      </section>
    {:else}
      {#each app.messages as message (message.id)}
        <article class:user={message.role === 'user'} class="message">
          {#if message.role !== 'user'}<div class="message-avatar">A</div>{/if}
          <div class="message-content">
            {#if message.text}{message.text}{/if}
            {#if message.job}<JobCard job={message.job} />{/if}
          </div>
        </article>
      {/each}
    {/if}
  </div>
</div>

{#if app.error}<div class="mx-auto mb-2 notice error-notice max-w-[760px]">{app.error}</div>{/if}

<div class="composer-wrap">
  <div class="composer">
    <textarea bind:this={textarea} bind:value={prompt} rows="1" oninput={resize} onkeydown={keydown} placeholder="Describe a task for Algoria…" aria-label="Message Algoria"></textarea>
    <div class="composer-row">
      <span class="composer-hint" aria-label="Execution safety policy"><ShieldCheck size={11} /> No service runs without approval <i></i> {app.policy.network} · {app.policy.maxPaymentUsdc} USDC hard cap</span>
      <button type="button" class="send-button" onclick={() => send()} disabled={!prompt.trim() || app.busy} aria-label="Send"><ArrowUp size={15} strokeWidth={2} /></button>
    </div>
  </div>
</div>
