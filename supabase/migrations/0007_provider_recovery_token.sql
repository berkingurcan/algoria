alter table public.provider_runs
  add column recovery_token_hash text not null
  check (recovery_token_hash ~ '^[a-f0-9]{64}$');
