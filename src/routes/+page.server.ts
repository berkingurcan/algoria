import type { PageServerLoad } from './$types';
import { listConversations, listMessages } from '$lib/server/db/conversations';
import type { Suggestion } from '$lib/state/app.svelte';
import { cached } from '$lib/server/catalog/cache';
import { searchStellar8004 } from '$lib/server/catalog/stellar8004';

/**
 * The welcome screen used to name three fixed capabilities, summarize,
 * extract and classify, which are the controlled test provider's services. The
 * mainnet deployment carries no such provider, so it opened by offering three
 * things it could not do, and every one of them would have routed to a scraper
 * or a search endpoint or to nothing at all.
 *
 * They come from the allowlisted catalogue now, so a deployment can only ever
 * offer what it is actually configured to run. If the catalogue cannot be read
 * the screen shows no suggestions, which is the honest answer: better to
 * suggest nothing than to suggest work that will not happen.
 */
async function deploymentSuggestions(): Promise<Suggestion[]> {
  try {
    const { resources } = await cached('welcome-suggestions', 300_000, () => searchStellar8004('', 20));
    return resources
      .filter((resource) => resource.executionStatus === 'ready' && resource.description)
      .slice(0, 3)
      .map((resource) => ({
        label: resource.serviceName || resource.name,
        detail: resource.name,
        prompt: resource.description
      }));
  } catch {
    return [];
  }
}

export const load: PageServerLoad = async ({ parent, locals }) => {
  const { auth } = await parent();
  const suggestions = await deploymentSuggestions();
  if (!auth) return { auth, conversations: [], messages: [], suggestions };
  const conversations = await listConversations(auth.userId).catch(() => []);
  const messages = conversations[0]
    ? await listMessages(auth.userId, conversations[0].id).catch(() => [])
    : [];
  return { auth, conversations, messages, suggestions };
};
