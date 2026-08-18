create table public.provider_runs (
  correlation_id uuid primary key,
  service text not null check (service in ('summarize', 'extract', 'classify')),
  request_hash text not null check (request_hash ~ '^[a-f0-9]{64}$'),
  status text not null check (status in ('processing', 'succeeded', 'failed', 'uncertain')),
  artifact jsonb,
  payment_receipt jsonb,
  payment_response text,
  failure_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '30 days'),
  check (
    (status = 'succeeded' and artifact is not null and payment_receipt is not null and payment_response is not null)
    or status <> 'succeeded'
  )
);

create index provider_runs_expiry_idx on public.provider_runs(expires_at);
create trigger provider_runs_updated_at before update on public.provider_runs
  for each row execute function public.set_updated_at();

alter table public.provider_runs enable row level security;
revoke all on public.provider_runs from public, anon, authenticated;
grant all on public.provider_runs to service_role;

create or replace function public.algoria_apply_retention() returns void
language plpgsql security definer set search_path = public as $$
begin
  delete from public.messages where expires_at < now();
  update public.jobs
    set request_content = null, result_content = null
    where content_expires_at < now() and (request_content is not null or result_content is not null);
  delete from public.conversations where expires_at < now();
  delete from public.jobs where record_expires_at < now();
  delete from public.payment_records where expires_at < now();
  delete from public.feedback_actions where expires_at < now();
  delete from public.audit_events where expires_at < now();
  delete from public.provider_runs where expires_at < now();
  delete from public.auth_sessions where expires_at < now() or revoked_at < now() - interval '7 days';
  delete from public.sep10_challenges where expires_at < now() or consumed_at < now() - interval '1 day';
end;
$$;
