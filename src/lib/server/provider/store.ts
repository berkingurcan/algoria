import { getAdminClient } from '$lib/server/db/client';
import type { ProviderServiceName } from './services';

export type ProviderRunStatus = 'processing' | 'succeeded' | 'failed' | 'uncertain';

export type ProviderRun = {
  correlation_id: string;
  service: ProviderServiceName;
  request_hash: string;
  recovery_token_hash: string;
  status: ProviderRunStatus;
  artifact: Record<string, unknown> | null;
  payment_receipt: Record<string, unknown> | null;
  payment_response: string | null;
  failure_code: string | null;
  created_at: string;
  updated_at: string;
  expires_at: string;
};

export interface ProviderRunStore {
  get(correlationId: string): Promise<ProviderRun | null>;
  claim(correlationId: string, service: ProviderServiceName, requestHash: string, recoveryTokenHash: string): Promise<{ claimed: boolean; run: ProviderRun }>;
  succeed(correlationId: string, artifact: Record<string, unknown>, receipt: Record<string, unknown>, paymentResponse: string): Promise<ProviderRun>;
  fail(correlationId: string, failureCode: string, uncertain?: boolean): Promise<ProviderRun>;
}

export const providerRunStore: ProviderRunStore = {
  async get(correlationId) {
    const { data, error } = await getAdminClient().from('provider_runs').select('*').eq('correlation_id', correlationId).maybeSingle();
    if (error) throw error;
    return data as ProviderRun | null;
  },

  async claim(correlationId, service, requestHash, recoveryTokenHash) {
    const { data, error } = await getAdminClient().from('provider_runs').insert({
      correlation_id: correlationId,
      service,
      request_hash: requestHash,
      recovery_token_hash: recoveryTokenHash,
      status: 'processing'
    }).select('*').single();
    if (!error) return { claimed: true, run: data as ProviderRun };
    if (error.code !== '23505') throw error;
    const run = await this.get(correlationId);
    if (!run) throw error;
    return { claimed: false, run };
  },

  async succeed(correlationId, artifact, receipt, paymentResponse) {
    const { data, error } = await getAdminClient().from('provider_runs').update({
      status: 'succeeded', artifact, payment_receipt: receipt, payment_response: paymentResponse, failure_code: null
    }).eq('correlation_id', correlationId).eq('status', 'processing').select('*').single();
    if (error) throw error;
    return data as ProviderRun;
  },

  async fail(correlationId, failureCode, uncertain = false) {
    const { data, error } = await getAdminClient().from('provider_runs').update({
      status: uncertain ? 'uncertain' : 'failed', failure_code: failureCode
    }).eq('correlation_id', correlationId).eq('status', 'processing').select('*').single();
    if (error) throw error;
    return data as ProviderRun;
  }
};
