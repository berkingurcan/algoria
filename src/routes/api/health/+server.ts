import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { LEAN_V0_FEATURES } from '$lib/constants';
import { assertLeanV0Configuration, policyFailure } from '$lib/server/network/policy';
import { schemaStatus } from '$lib/server/db/jobs';

/**
 * Health is the one route a monitor is meant to poll, and answering it costs a
 * database round trip, so a healthy answer is held briefly rather than re-asked
 * on every request. Deliberately a local memo and not the shared catalog cache:
 * that one refuses work once enough loads are in flight, and a liveness endpoint
 * that reports failure because something else was busy is worse than no cache.
 *
 * Only `ok` is remembered. `deployment is complete` is exactly what the canary
 * reads this for, and `pnpm run deploy` polls it seconds after the upload, so latching
 * one cold-start blip for half a minute would fail a deployment that had already
 * recovered. A bad answer is therefore always re-derived.
 */
const SCHEMA_OK_TTL_MS = 30_000;
let schemaOkUntil = 0;

async function currentSchemaStatus() {
  if (Date.now() < schemaOkUntil) return 'ok' as const;
  const status = await schemaStatus().catch((): 'unavailable' => 'unavailable');
  if (status === 'ok') schemaOkUntil = Date.now() + SCHEMA_OK_TTL_MS;
  return status;
}

export const GET: RequestHandler = async () => {
  try {
    const network = assertLeanV0Configuration();
    const schema = await currentSchemaStatus();
    return json({
      ok: true,
      service: 'algoria',
      version: '0.1.0',
      network: network.caip2,
      environment: network.environment,
      features: LEAN_V0_FEATURES,
      schema,
      time: new Date().toISOString()
    });
  } catch (error) {
    const failure = policyFailure(error);
    if (failure) return json({ ok: false, ...failure.body }, { status: failure.status });
    throw error;
  }
};
