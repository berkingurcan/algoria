import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireAuth } from '$lib/server/auth/require';
import { resolveCatalogResource } from '$lib/server/catalog/resolve';
import { resolveRequestShape } from '$lib/server/execution/shape';
import { signPreparedExecution } from '$lib/server/execution/preparation';
import { compileArguments, MissingInputError } from '$lib/server/openrouter';
import { safeErrorMessage } from '$lib/server/shared/sanitize';
import { assertLeanV0Selection, policyFailure } from '$lib/server/network/policy';
import { readBoundedJsonObject } from '$lib/server/security/body';

export const POST: RequestHandler = async (event) => {
  const { auth } = requireAuth(event);
  const body = await readBoundedJsonObject(event.request).catch((): Record<string, unknown> => ({}));
  const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
  if (prompt.length < 2 || prompt.length > 4_000) return json({ message: 'Prompt must contain 2-4000 characters' }, { status: 400 });

  try {
    assertLeanV0Selection(body.resource);
    const resource = await resolveCatalogResource(body.resource);
    assertLeanV0Selection(resource);
    if (resource.executionStatus !== 'ready') throw new Error(`The selected service is ${resource.executionStatus.replaceAll('-', ' ')}`);
    const protocol = resource.protocols.includes('x402') ? 'x402' : 'http';

    const schema = resource.inputSchema ?? { type: 'object', properties: {} };
    const compiled = await compileArguments(prompt, schema, resource.inputExample);
    const shape = await resolveRequestShape(resource, compiled, resource.inputExample !== undefined);
    const { arguments: args, snapshot } = shape;
    const signed = await signPreparedExecution(auth.userId, prompt, resource, protocol, { kind: 'http', snapshot, arguments: args });
    return json({
      token: signed.token,
      expiresAt: signed.expiresAt,
      arguments: args,
      preview: {
        kind: 'http', endpoint: snapshot.url, method: snapshot.method,
        correlationId: snapshot.correlationId, body: snapshot.body, arguments: args,
        shape: shape.confidence
      }
    }, { headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    const policy = policyFailure(error);
    if (!policy && error instanceof MissingInputError) {
      return json({ message: error.message, missing: error.fields }, { status: 422 });
    }
    return json(
      policy?.body ?? { message: safeErrorMessage(error) },
      { status: policy?.status ?? 400 }
    );
  }
};
