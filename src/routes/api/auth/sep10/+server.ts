import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { createSep10Challenge, verifySep10Challenge } from '$lib/server/auth/sep10';
import { createSession } from '$lib/server/auth/session';
import { getAdminClient } from '$lib/server/db/client';
import { safeErrorMessage } from '$lib/server/shared/sanitize';
import { readBoundedJsonObject } from '$lib/server/security/body';

export const GET: RequestHandler = async ({ url }) => {
  try {
    return json(await createSep10Challenge(url.searchParams.get('account') || ''), { headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    return json({ message: safeErrorMessage(error, 'Could not create a SEP-10 challenge') }, { status: 400 });
  }
};

export const POST: RequestHandler = async ({ request, cookies }) => {
  try {
    const contentType = request.headers.get('content-type') || '';
    const transaction = contentType.includes('application/json')
      ? (await readBoundedJsonObject(request)).transaction
      : (await request.formData()).get('transaction');
    if (typeof transaction !== 'string') return json({ message: 'Signed transaction is required' }, { status: 400 });
    const walletAddress = await verifySep10Challenge(transaction);
    const { data, error } = await getAdminClient().from('app_users')
      .upsert({ stellar_address: walletAddress }, { onConflict: 'stellar_address' })
      .select('id,stellar_address').single();
    if (error) throw error;
    await createSession(cookies, { userId: data.id, walletAddress: data.stellar_address });
    return json({ token: 'session-cookie', userId: data.id, walletAddress: data.stellar_address });
  } catch (error) {
    return json({ message: safeErrorMessage(error, 'Wallet verification failed') }, { status: 401 });
  }
};
