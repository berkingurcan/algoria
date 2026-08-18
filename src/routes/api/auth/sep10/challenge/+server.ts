import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { createSep10Challenge } from '$lib/server/auth/sep10';
import { safeErrorMessage } from '$lib/server/shared/sanitize';

export const GET: RequestHandler = async ({ url }) => {
  try {
    const account = url.searchParams.get('account') || '';
    return json(await createSep10Challenge(account), { headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    return json({ message: safeErrorMessage(error, 'Could not create a SEP-10 challenge') }, { status: 400 });
  }
};
