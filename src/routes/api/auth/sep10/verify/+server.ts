import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { verifySep10Challenge } from '$lib/server/auth/sep10';
import { createSession } from '$lib/server/auth/session';
import { getAdminClient } from '$lib/server/db/client';
import { safeErrorMessage } from '$lib/server/shared/sanitize';
import { readBoundedJsonObject } from '$lib/server/security/body';

export const POST: RequestHandler = async ({ request, cookies }) => {
  try {
    const body = await readBoundedJsonObject(request);
    if (typeof body.transaction !== 'string') return json({ message: 'Signed transaction is required' }, { status: 400 });
    const walletAddress = await verifySep10Challenge(body.transaction);
    const admin = getAdminClient();
    const { data, error } = await admin.from('app_users')
      .upsert({ stellar_address: walletAddress }, { onConflict: 'stellar_address' })
      .select('id,stellar_address')
      .single();
    if (error) throw error;
    await createSession(cookies, { userId: data.id, walletAddress: data.stellar_address });
    return json({ userId: data.id, walletAddress: data.stellar_address }, { headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    return json({ message: safeErrorMessage(error, 'Wallet verification failed') }, { status: 401 });
  }
};
