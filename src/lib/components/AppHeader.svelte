<script lang="ts">
  import { Menu, Moon, Sun } from '@lucide/svelte';
  import WalletButton from './WalletButton.svelte';
  import { useAlgoriaState } from '$lib/state/app.svelte';

  const app = useAlgoriaState();
  let light = $state(false);

  function toggleTheme() {
    light = !light;
    document.documentElement.classList.toggle('light', light);
    localStorage.setItem('algoria-theme', light ? 'light' : 'dark');
  }

  $effect(() => {
    if (typeof window === 'undefined') return;
    light = localStorage.getItem('algoria-theme') === 'light';
    document.documentElement.classList.toggle('light', light);
  });
</script>

<header class="topbar">
  <button type="button" class="icon-button mobile-only" aria-label="Open sidebar" onclick={() => app.sidebarOpen = true}>
    <Menu size={17} strokeWidth={1.5} />
  </button>
  <div class="topbar-title display">{app.activeConversationId ? app.conversations.find((item) => item.id === app.activeConversationId)?.title ?? 'Conversation' : 'New conversation'}</div>
  <span class="network-pill hidden sm:inline-flex"><span></span> {app.policy.network}</span>
  <button type="button" class="icon-button" aria-label="Toggle theme" onclick={toggleTheme}>
    {#if light}<Sun size={15} strokeWidth={1.5} />{:else}<Moon size={15} strokeWidth={1.5} />{/if}
  </button>
  <WalletButton />
</header>
