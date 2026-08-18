import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { revokeSession } from '$lib/server/auth/session';

export const POST: RequestHandler = async ({ cookies }) => {
  await revokeSession(cookies);
  return json({ ok: true });
};
