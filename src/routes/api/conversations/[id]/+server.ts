import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireAuth } from '$lib/server/auth/require';
import { listMessages } from '$lib/server/db/conversations';
import { getAdminClient } from '$lib/server/db/client';

export const GET: RequestHandler = async (event) => {
  const { auth } = requireAuth(event);
  return json({ messages: await listMessages(auth.userId, event.params.id) });
};

export const DELETE: RequestHandler = async (event) => {
  const { auth } = requireAuth(event);
  const { error } = await getAdminClient().from('conversations')
    .delete().eq('id', event.params.id).eq('user_id', auth.userId);
  if (error) return json({ message: error.message }, { status: 400 });
  return new Response(null, { status: 204 });
};
