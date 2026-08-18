<script lang="ts">
  import { ArrowUpRight, GitBranch, MessageSquare, Plus, X } from '@lucide/svelte';
  import { useAlgoriaState } from '$lib/state/app.svelte';

  const app = useAlgoriaState();

  function relativeTime(value: string) {
    const hours = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 3_600_000));
    if (hours < 1) return 'now';
    if (hours < 24) return `${hours}h`;
    return `${Math.floor(hours / 24)}d`;
  }
</script>

{#if app.sidebarOpen}<button type="button" class="backdrop" aria-label="Close sidebar" onclick={() => app.sidebarOpen = false}></button>{/if}

<aside class:open={app.sidebarOpen} class="sidebar">
  <div class="brand">
    <div class="brand-mark display">A</div>
    <div class="brand-copy"><strong class="display">Algoria</strong><span>Execution client</span></div>
    <button class="icon-button mobile-only ml-auto" type="button" aria-label="Close sidebar" onclick={() => app.sidebarOpen = false}><X size={15} /></button>
  </div>

  <button class="new-chat new-chat-primary" type="button" onclick={() => app.newConversation()}>
    <Plus size={15} strokeWidth={1.7} /> <span>New conversation</span><span class="new-chat-shortcut">⌘N</span>
  </button>
  <div class="section-label">Recent · 30 days</div>
  <div class="conversation-list">
    {#if app.conversations.length === 0}
      <div class="sidebar-empty"><MessageSquare size={15} /><span>Verified conversations appear here for 30 days.</span></div>
    {:else}
      {#each app.conversations as conversation (conversation.id)}
        <div class="conversation-item">
          <button type="button" class:active={app.activeConversationId === conversation.id} class="side-link" onclick={() => app.openConversation(conversation.id)}>
            <MessageSquare size={13} strokeWidth={1.5} />
            <span class="conversation-title">{conversation.title}</span>
            <time>{relativeTime(conversation.updatedAt)}</time>
          </button>
        </div>
      {/each}
    {/if}
  </div>

  <div class="sidebar-footer">
    <a class="side-link" href="https://github.com/berkingurcan/algoria" target="_blank" rel="noreferrer">
      <GitBranch size={14} strokeWidth={1.5} /> <span>Open source</span><ArrowUpRight size={12} class="ml-auto" />
    </a>
    <div class="sidebar-network"><span></span><div><strong>{app.policy.network}</strong><small>8004 identity · x402 exact</small></div></div>
  </div>
</aside>
