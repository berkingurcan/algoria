import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireAuth } from '$lib/server/auth/require';
import { resolveCatalogResource } from '$lib/server/catalog/resolve';
import { createConversation, addMessage } from '$lib/server/db/conversations';
import { audit, insertJob, insertPayment, updateJob, updatePayment, updatePersistedJobMessage } from '$lib/server/db/jobs';
import { responseResult, sendSnapshot } from '$lib/server/execution/http';
import { assertPreparedResource, verifyPreparedExecution } from '$lib/server/execution/preparation';
import { MissingInputError } from '$lib/server/openrouter';
import { parseX402Quote, quoteHash } from '$lib/server/payments/x402';
import { safeErrorMessage } from '$lib/server/shared/sanitize';
import { assertLeanV0Selection, policyFailure, UnsupportedPolicyError } from '$lib/server/network/policy';
import type { CatalogResource } from '$lib/types/catalog';
import type { JobCard } from '$lib/types/chat';
import { readBoundedJsonObject } from '$lib/server/security/body';

function expiresAt(seconds?: number) {
  const bounded = Math.min(Math.max(seconds ?? 120, 30), 300);
  return new Date(Date.now() + bounded * 1_000).toISOString();
}

export const POST: RequestHandler = async (event) => {
  const { auth } = requireAuth(event);
  const body = await readBoundedJsonObject(event.request).catch((): Record<string, unknown> => ({}));
  const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
  if (prompt.length < 2 || prompt.length > 4_000) return json({ message: 'Prompt must contain 2-4000 characters' }, { status: 400 });

  let executionContext: {
    row: Awaited<ReturnType<typeof insertJob>>;
    resource: CatalogResource;
    conversationId: string;
    newConversation: Awaited<ReturnType<typeof createConversation>> | null;
    cardPersisted: boolean;
    paymentId?: string;
  } | null = null;
  let finalized = false;

  try {
    assertLeanV0Selection(body.resource);
    const prepared = await verifyPreparedExecution(body.preparationToken, auth.userId, prompt);
    const resource = await resolveCatalogResource(body.resource);
    assertLeanV0Selection(resource);
    if (resource.executionStatus !== 'ready') throw new Error(`The selected service is ${resource.executionStatus.replaceAll('-', ' ')}`);
    assertPreparedResource(prepared, resource);
    const protocol = prepared.protocol;
    if (protocol !== 'http' && protocol !== 'x402') throw new UnsupportedPolicyError('executionProtocol');
    if (prepared.action.kind !== 'http') throw new UnsupportedPolicyError('mcpExecution');
    const args = prepared.action.arguments;
    const snapshot = prepared.action.snapshot;

    const newConversation = typeof body.conversationId === 'string'
      ? null
      : await createConversation(auth.userId, prompt);
    const conversationId = typeof body.conversationId === 'string' ? body.conversationId : newConversation!.id;
    await addMessage(auth.userId, conversationId, { role: 'user', kind: 'text', text: prompt });

    const row = await insertJob(auth.userId, conversationId, resource, protocol, prompt, prepared.preparationId);
    executionContext = { row, resource, conversationId, newConversation, cardPersisted: false };
    let card: JobCard = { id: row.id, prompt, selected: resource, arguments: args, correlationId: snapshot.correlationId, state: 'probing' };
    await updateJob(row.id, { state: 'probing', request_content: { prompt, arguments: args, snapshot } });
    // Persist the card before egress so an interrupted run stays visible after reload instead of vanishing.
    await addMessage(auth.userId, conversationId, { role: 'assistant', kind: 'job', job: card });
    executionContext.cardPersisted = true;

    const { response } = await sendSnapshot(snapshot);

    if (response.status === 402) {
      const x402Header = response.headers.get('payment-required') ?? response.headers.get('x-payment-required');
      if (x402Header) {
        const quote = parseX402Quote(x402Header);
        const quoteExpiry = expiresAt(quote.option.maxTimeoutSeconds);
        const payment = await insertPayment(auth.userId, row.id, 'x402', quote.option, quoteHash(x402Header), quoteExpiry);
        executionContext.paymentId = payment.id;
        card = { ...card, state: 'awaiting-payment', payment: {
          ...quote.option, protocol: 'x402', quoteId: payment.id, expiresAt: quoteExpiry, paymentRequired: x402Header,
          recoverable: Boolean(snapshot.recoveryUrl)
        } };
        await updateJob(row.id, { state: 'awaiting-payment', request_content: { prompt, arguments: args, snapshot, paymentRequired: x402Header } });
      } else if (response.headers.has('www-authenticate')) {
        throw new UnsupportedPolicyError('mppPayment', 'The service requested MPP, which is outside lean v0');
      } else {
        throw new Error('The endpoint returned 402 without a supported x402 challenge');
      }
    } else {
      const result = await responseResult(response);
      card = response.ok
        ? { ...card, state: 'succeeded', result }
        : { ...card, state: 'failed', result, error: `Agent endpoint returned ${response.status}` };
      await updateJob(row.id, { state: card.state, result_content: result.body, failure_code: response.ok ? null : `http_${response.status}` });
    }

    finalized = true;
    await updatePersistedJobMessage(conversationId, card).catch(() => undefined);
    await audit(auth.userId, 'job.execute', 'job', row.id, card.state).catch(() => undefined);
    return json({ job: card, conversation: newConversation }, { status: 201 });
  } catch (error) {
    const policy = policyFailure(error);
    const message = policy?.body.message ?? (error instanceof MissingInputError ? error.message : safeErrorMessage(error));
    if (executionContext && !finalized) {
      const state = error instanceof MissingInputError ? 'needs-input' : 'failed';
      const card: JobCard = {
        id: executionContext.row.id,
        prompt,
        selected: executionContext.resource,
        inputSchema: executionContext.resource.inputSchema,
        state,
        error: message
      };
      await Promise.allSettled([
        updateJob(executionContext.row.id, {
          state,
          failure_code: policy?.body.code ?? (error instanceof MissingInputError ? 'missing_input' : 'execution_failed')
        }),
        // A quote minted for a job that just failed must not stay claimable.
        ...(executionContext.paymentId ? [updatePayment(executionContext.paymentId, { status: 'expired' })] : []),
        executionContext.cardPersisted
          ? updatePersistedJobMessage(executionContext.conversationId, card)
          : addMessage(auth.userId, executionContext.conversationId, { role: 'assistant', kind: 'job', job: card }),
        audit(auth.userId, 'job.execute', 'job', executionContext.row.id, state)
      ]);
      return json(
        { ...(policy ? { code: policy.body.code } : {}), message, job: card, conversation: executionContext.newConversation },
        { status: policy?.status ?? (error instanceof MissingInputError ? 422 : 502) }
      );
    }
    return json(policy?.body ?? { message }, { status: policy?.status ?? (error instanceof MissingInputError ? 422 : 400) });
  }
};
