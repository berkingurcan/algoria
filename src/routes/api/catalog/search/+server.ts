import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async () => json({
  code: 'unsupported-policy',
  message: 'Open catalog discovery is disabled in lean v0; only allowlisted Stellar 8004 test services can be routed'
}, { status: 501, headers: { 'cache-control': 'no-store' } });
