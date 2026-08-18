import { error, type RequestEvent } from '@sveltejs/kit';

export function requireAuth(event: Pick<RequestEvent, 'locals'>) {
  if (!event.locals.auth || !event.locals.accessToken) throw error(401, 'Stellar wallet verification required');
  return { auth: event.locals.auth, accessToken: event.locals.accessToken };
}
