<script lang="ts">
  import type { PageData } from './$types';
  import { provideAlgoriaState } from '$lib/state/app.svelte';
  import ConversationSidebar from '$lib/components/ConversationSidebar.svelte';
  import AppHeader from '$lib/components/AppHeader.svelte';
  import ChatPane from '$lib/components/ChatPane.svelte';
  import AgentInspector from '$lib/components/AgentInspector.svelte';
  import type { InitialState } from '$lib/state/app.svelte';

  let { data }: { data: PageData } = $props();
  function initialState(): InitialState {
    return {
      auth: data.auth ?? null,
      conversations: data.conversations ?? [],
      messages: data.messages ?? [],
      policy: data.policy,
      suggestions: data.suggestions ?? []
    };
  }
  const app = provideAlgoriaState(initialState());

  function handleShortcut(event: KeyboardEvent) {
    if (!(event.metaKey || event.ctrlKey)) return;
    if (event.key.toLowerCase() === 'n') {
      event.preventDefault();
      app.newConversation();
    }
  }
</script>

<svelte:window onkeydown={handleShortcut} />

<div class="app-frame">
  <ConversationSidebar />
  <div class="workspace">
    <main class="main-card">
      <section class="chat-column">
        <AppHeader />
        <ChatPane />
      </section>
      <AgentInspector />
    </main>
  </div>
</div>
