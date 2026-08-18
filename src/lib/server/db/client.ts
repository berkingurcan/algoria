import { env as privateEnv } from '$env/dynamic/private';
import { env as publicEnv } from '$env/dynamic/public';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

let adminClient: SupabaseClient | null = null;

export function isDatabaseConfigured(): boolean {
  return Boolean(publicEnv.PUBLIC_SUPABASE_URL && privateEnv.SUPABASE_SECRET_KEY);
}

export function getAdminClient(): SupabaseClient {
  if (adminClient) return adminClient;
  if (!publicEnv.PUBLIC_SUPABASE_URL || !privateEnv.SUPABASE_SECRET_KEY) {
    throw new Error('Supabase server credentials are not configured');
  }
  adminClient = createClient(publicEnv.PUBLIC_SUPABASE_URL, privateEnv.SUPABASE_SECRET_KEY, {
    auth: { persistSession: false, autoRefreshToken: false }
  });
  return adminClient;
}
