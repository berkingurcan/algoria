import { createHash, randomUUID } from 'node:crypto';
import { env } from '$env/dynamic/private';
import { jwtVerify, SignJWT } from 'jose';
import type { CatalogResource } from '$lib/types/catalog';
import type { RequestSnapshot } from './http';
import { endpointKey } from '$lib/utils/url';

const PREPARATION_TTL_SECONDS = 5 * 60;

export type PreparedExecution = {
  version: 1;
  preparationId: string;
  resourceKey: string;
  endpoint: string;
  protocol: 'mcp' | 'http' | 'x402';
  promptHash: string;
  action:
    | { kind: 'mcp'; tool: string; arguments: Record<string, unknown> }
    | { kind: 'http'; snapshot: RequestSnapshot; arguments: Record<string, unknown> };
};

function secret(): Uint8Array {
  if (!env.ALGORIA_JWT_SECRET || env.ALGORIA_JWT_SECRET.length < 32) {
    throw new Error('ALGORIA_JWT_SECRET must contain at least 32 characters');
  }
  return new TextEncoder().encode(env.ALGORIA_JWT_SECRET);
}

function promptHash(prompt: string): string {
  return createHash('sha256').update(prompt).digest('hex');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPreparedExecution(value: unknown): value is PreparedExecution {
  if (!isRecord(value) || value.version !== 1 || typeof value.preparationId !== 'string' ||
    typeof value.resourceKey !== 'string' || typeof value.endpoint !== 'string' ||
    typeof value.protocol !== 'string' || typeof value.promptHash !== 'string' || !isRecord(value.action)) return false;
  if (value.action.kind === 'mcp') {
    return typeof value.action.tool === 'string' && isRecord(value.action.arguments);
  }
  if (value.action.kind === 'http') {
    return isRecord(value.action.snapshot) && isRecord(value.action.arguments);
  }
  return false;
}

export async function signPreparedExecution(
  userId: string,
  prompt: string,
  resource: CatalogResource,
  protocol: PreparedExecution['protocol'],
  action: PreparedExecution['action']
): Promise<{ token: string; expiresAt: string; prepared: PreparedExecution }> {
  const preparationId = randomUUID();
  const prepared: PreparedExecution = {
    version: 1,
    preparationId,
    resourceKey: resource.key,
    endpoint: resource.endpoint,
    protocol,
    promptHash: promptHash(prompt),
    action
  };
  const expiresAt = new Date(Date.now() + PREPARATION_TTL_SECONDS * 1_000).toISOString();
  const token = await new SignJWT({ execution: prepared })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuer('algoria')
    .setAudience('execution-preparation')
    .setSubject(userId)
    .setJti(preparationId)
    .setIssuedAt()
    .setExpirationTime(`${PREPARATION_TTL_SECONDS}s`)
    .sign(secret());
  return { token, expiresAt, prepared };
}

export async function verifyPreparedExecution(token: unknown, userId: string, prompt: string): Promise<PreparedExecution> {
  if (typeof token !== 'string' || token.length > 100_000) throw new Error('Prepare the exact request before approval');
  const { payload } = await jwtVerify(token, secret(), {
    algorithms: ['HS256'], issuer: 'algoria', audience: 'execution-preparation', subject: userId
  });
  if (!isPreparedExecution(payload.execution) || payload.jti !== payload.execution.preparationId) {
    throw new Error('The prepared request is invalid');
  }
  if (payload.execution.promptHash !== promptHash(prompt)) throw new Error('The prompt changed after request review');
  return payload.execution;
}

export function assertPreparedResource(prepared: PreparedExecution, resource: CatalogResource): void {
  if (prepared.resourceKey !== resource.key || endpointKey(prepared.endpoint) !== endpointKey(resource.endpoint)) {
    throw new Error('The selected agent changed after request review; prepare it again');
  }
  const expected = resource.protocols.includes('mcp') ? 'mcp' : (resource.protocols.includes('x402') ? 'x402' : 'http');
  if (prepared.protocol !== expected || prepared.action.kind !== (expected === 'mcp' ? 'mcp' : 'http')) {
    throw new Error('The agent protocol changed after request review; prepare it again');
  }
}
