<script lang="ts">
  import '../app.css';
  let { children } = $props();
</script>

<svelte:head>
  <title>Algoria: Stellar Agent Chat</title>
  <meta name="description" content="Find, trust, pay, and talk to Stellar agents in one minimal chat." />
</svelte:head>

{@render children()}
