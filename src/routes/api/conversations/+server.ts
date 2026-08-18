import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireAuth } from '$lib/server/auth/require';
import { createConversation, listConversations } from '$lib/server/db/conversations';
import { readBoundedJsonObject } from '$lib/server/security/body';

export const GET: RequestHandler = async (event) => {
  const { auth } = requireAuth(event);
  return json({ conversations: await listConversations(auth.userId) });
};

export const POST: RequestHandler = async (event) => {
  const { auth } = requireAuth(event);
  const body = await readBoundedJsonObject(event.request);
  const title = typeof body.title === 'string' ? body.title : 'New conversation';
  return json({ conversation: await createConversation(auth.userId, title) }, { status: 201 });
};
