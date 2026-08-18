import type { CatalogResource } from '$lib/types/catalog';
import { buildRequestSnapshot, sendSnapshot, type RequestSnapshot } from './http';

/**
 * Stellar 8004 leaves `inputExample` optional, and the services running in
 * production omit it, so the request shape often has to be inferred from the
 * prompt. An unpaid probe narrows that guess for free, but only partly:
 *
 *   - Some services validate before charging (a wrong shape answers 4xx), so a
 *     probe genuinely rejects bad candidates.
 *   - Others run payment middleware first and answer 402 to anything, even an
 *     empty body, so a probe proves nothing about the shape.
 *
 * The probe is therefore treated as a filter that can reject but never confirm.
 * What it cannot settle is disclosed to the user, who reviews the exact request
 * and the exact amount before signing.
 */
export type ShapeConfidence = 'declared' | 'endpoint-validated' | 'inferred';

export interface ResolvedRequestShape {
  arguments: Record<string, unknown>;
  snapshot: RequestSnapshot;
  confidence: ShapeConfidence;
}

function scalarsOf(payload: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(payload).filter(([, value]) => ['string', 'number', 'boolean'].includes(typeof value))
  );
}

/**
 * The compiled request first, whether it came from a declared example or was
 * inferred, then the same fields as query parameters. An operator-authored
 * shape is already explicit about method and placement, so it stands alone.
 */
export function candidateShapes(payload: Record<string, unknown>): Array<Record<string, unknown>> {
  if (payload.type === 'http') return [payload];
  const candidates: Array<Record<string, unknown>> = [payload];
  const scalars = scalarsOf(payload);
  if (Object.keys(scalars).length > 0) {
    candidates.push({ type: 'http', method: 'GET', queryParams: scalars });
  }
  return candidates;
}

/** A shape the endpoint refused outright is the one thing a probe can prove. */
export function probeRejectsShape(status: number): boolean {
  return status >= 400 && status < 500 && status !== 402;
}

/**
 * Registration metadata is self-declared and unverified, so a declared example
 * can be wrong: one registered service publishes a JSON body while its endpoint
 * only accepts a query parameter and refuses the body outright. The declared
 * shape is therefore tried first but still checked, and a refusal moves on to
 * the next candidate rather than sending the user to pay for a request the
 * service will reject.
 */
export async function resolveRequestShape(
  resource: CatalogResource,
  args: Record<string, unknown>,
  declared: boolean
): Promise<ResolvedRequestShape> {
  const candidates = candidateShapes(args);
  let rejectedAny = false;

  for (const candidate of candidates) {
    const snapshot = buildRequestSnapshot(resource, candidate);
    let status: number;
    try {
      status = (await sendSnapshot(snapshot)).response.status;
    } catch {
      // A transport failure says nothing about the shape; fall back to declared order.
      if (candidate === candidates[0]) return { arguments: candidate, snapshot, confidence: declared ? 'declared' : 'inferred' };
      continue;
    }
    if (probeRejectsShape(status)) {
      rejectedAny = true;
      continue;
    }
    return {
      arguments: candidate,
      snapshot,
      // A refusal is the only proof the endpoint inspects requests at all; without
      // one, a 402 from a service that charges before validating means nothing.
      confidence: rejectedAny ? 'endpoint-validated' : declared ? 'declared' : 'inferred'
    };
  }

  throw new Error('The service refused every request shape Algoria could derive for it');
}
