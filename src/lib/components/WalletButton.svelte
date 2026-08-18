<script lang="ts">
  import { WalletCards, LogOut, LoaderCircle } from '@lucide/svelte';
  import { ACTIVE_NETWORK_LABEL, ACTIVE_NETWORK_PASSPHRASE } from '$lib/constants';
  import { useAlgoriaState } from '$lib/state/app.svelte';
  import { getWalletKit } from '$lib/client/wallet';

  const app = useAlgoriaState();
  let connecting = $state(false);
  let walletKit: typeof import('@creit.tech/stellar-wallets-kit/sdk').StellarWalletsKit | null = null;

  async function loadWalletKit() {
    if (walletKit) return walletKit;
    walletKit = await getWalletKit();
    return walletKit;
  }

  async function connect() {
    if (connecting) return;
    connecting = true;
    app.error = null;
    try {
      const kit = await loadWalletKit();
      const { address } = await kit.authModal();
      const challengeResponse = await fetch(`/api/auth/sep10/challenge?account=${encodeURIComponent(address)}`);
      const challenge = await challengeResponse.json();
      if (!challengeResponse.ok) throw new Error(challenge.message || 'Could not create a SEP-10 challenge.');
      if (challenge.networkPassphrase !== ACTIVE_NETWORK_PASSPHRASE) throw new Error(`Wallet challenge is not for ${ACTIVE_NETWORK_LABEL}.`);
      const { signedTxXdr } = await kit.signTransaction(challenge.transaction, {
        networkPassphrase: ACTIVE_NETWORK_PASSPHRASE,
        address
      });
      const verifyResponse = await fetch('/api/auth/sep10/verify', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ transaction: signedTxXdr })
      });
      const verified = await verifyResponse.json();
      if (!verifyResponse.ok) throw new Error(verified.message || 'Wallet verification failed.');
      app.setAuth({ userId: verified.userId, walletAddress: verified.walletAddress });
      await app.refreshConversations();
    } catch (error) {
      app.error = error instanceof Error ? error.message : 'Wallet connection failed.';
    } finally {
      connecting = false;
    }
  }

  async function disconnect() {
    await fetch('/api/auth/logout', { method: 'POST' });
    await walletKit?.disconnect();
    app.setAuth(null);
    app.newConversation();
  }

  const shortAddress = $derived(app.auth
    ? `${app.auth.walletAddress.slice(0, 5)}…${app.auth.walletAddress.slice(-4)}`
    : 'Connect wallet');
</script>

{#if app.auth}
  <button class="wallet-button mono" type="button" onclick={disconnect} title="Disconnect wallet">
    <span>{shortAddress}</span><LogOut size={12} strokeWidth={1.5} />
  </button>
{:else}
  <button class="wallet-button" type="button" onclick={connect} disabled={connecting}>
    {#if connecting}<LoaderCircle size={13} class="animate-spin" />{:else}<WalletCards size={13} strokeWidth={1.5} />{/if}
    <span>{connecting ? 'Verifying…' : shortAddress}</span>
  </button>
{/if}
