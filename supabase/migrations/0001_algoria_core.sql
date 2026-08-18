create extension if not exists pgcrypto with schema extensions;
create extension if not exists pg_cron with schema extensions;

create type public.message_role as enum ('user', 'assistant', 'system');
create type public.message_kind as enum ('text', 'job');
create type public.job_state as enum (
  'routing', 'awaiting-agent-selection', 'needs-input', 'awaiting-job-approval',
  'probing', 'awaiting-payment', 'signing', 'executing', 'payment-uncertain',
  'succeeded', 'failed', 'cancelled'
);
create type public.payment_protocol as enum ('x402', 'mpp');

create table public.app_users (
  id uuid primary key default gen_random_uuid(),
  stellar_address text not null unique check (stellar_address ~ '^G[A-Z2-7]{55}$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.auth_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.app_users(id) on delete cascade,
  refresh_hash text not null unique,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  last_used_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create table public.sep10_challenges (
  challenge_hash text primary key,
  stellar_address text not null check (stellar_address ~ '^G[A-Z2-7]{55}$'),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now()
);

create table public.conversations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.app_users(id) on delete cascade,
  title text not null check (char_length(title) between 1 and 120),
  expires_at timestamptz not null default (now() + interval '30 days'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  user_id uuid not null references public.app_users(id) on delete cascade,
  role public.message_role not null,
  kind public.message_kind not null default 'text',
  content jsonb not null default '{}'::jsonb,
  expires_at timestamptz not null default (now() + interval '30 days'),
  created_at timestamptz not null default now()
);

create table public.jobs (
  id uuid primary key default gen_random_uuid(),
  preparation_id uuid unique,
  user_id uuid not null references public.app_users(id) on delete cascade,
  conversation_id uuid references public.conversations(id) on delete set null,
  catalog_source text not null check (catalog_source in ('stellar8004', 'x402-bazaar')),
  external_resource_key text not null,
  agent_8004_id integer check (agent_8004_id is null or agent_8004_id >= 0),
  endpoint text not null,
  protocol text,
  service_snapshot jsonb not null,
  request_hash text not null,
  request_content jsonb,
  result_content jsonb,
  state public.job_state not null,
  failure_code text,
  content_expires_at timestamptz not null default (now() + interval '30 days'),
  record_expires_at timestamptz not null default (now() + interval '365 days'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.payment_records (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.app_users(id) on delete cascade,
  job_id uuid not null references public.jobs(id) on delete cascade,
  protocol public.payment_protocol not null,
  network text not null,
  asset text not null,
  amount_atomic numeric(40,0) not null check (amount_atomic >= 0),
  pay_to text not null,
  quote_hash text not null,
  payment_signature_hash text,
  tx_hash text unique,
  status text not null check (status in ('quoted', 'signed', 'reconciling', 'settled', 'failed', 'expired')),
  quote_expires_at timestamptz not null,
  expires_at timestamptz not null default (now() + interval '365 days'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(job_id, quote_hash)
);

create table public.feedback_actions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.app_users(id) on delete cascade,
  job_id uuid not null references public.jobs(id) on delete cascade,
  agent_8004_id integer not null check (agent_8004_id >= 0),
  score integer not null check (score between 20 and 100 and score % 20 = 0),
  tag1 text not null check (char_length(tag1) between 1 and 32),
  tag2 text check (tag2 is null or char_length(tag2) <= 32),
  tx_hash text unique,
  status text not null check (status in ('prepared', 'submitted', 'confirmed', 'failed')),
  expires_at timestamptz not null default (now() + interval '365 days'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(job_id)
);

create table public.audit_events (
  id bigint generated always as identity primary key,
  user_id uuid references public.app_users(id) on delete set null,
  request_id uuid not null default gen_random_uuid(),
  event_type text not null,
  target_type text,
  target_id text,
  outcome text not null,
  expires_at timestamptz not null default (now() + interval '365 days'),
  created_at timestamptz not null default now()
);

create index conversations_owner_updated_idx on public.conversations(user_id, updated_at desc);
create index conversations_expiry_idx on public.conversations(expires_at);
create index messages_conversation_created_idx on public.messages(conversation_id, created_at);
create index messages_owner_idx on public.messages(user_id);
create index messages_expiry_idx on public.messages(expires_at);
create index jobs_owner_created_idx on public.jobs(user_id, created_at desc);
create index jobs_conversation_idx on public.jobs(conversation_id);
create index jobs_content_expiry_idx on public.jobs(content_expires_at);
create index jobs_record_expiry_idx on public.jobs(record_expires_at);
create index payment_records_owner_created_idx on public.payment_records(user_id, created_at desc);
create index payment_records_quote_expiry_idx on public.payment_records(quote_expires_at);
create index payment_records_expiry_idx on public.payment_records(expires_at);
create index feedback_actions_owner_idx on public.feedback_actions(user_id, created_at desc);
create index audit_events_owner_idx on public.audit_events(user_id, created_at desc);
create index audit_events_expiry_idx on public.audit_events(expires_at);
create index auth_sessions_active_idx on public.auth_sessions(refresh_hash) where revoked_at is null;
create index sep10_challenges_expiry_idx on public.sep10_challenges(expires_at);

create function public.set_updated_at() returns trigger language plpgsql security invoker as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger app_users_updated_at before update on public.app_users for each row execute function public.set_updated_at();
create trigger conversations_updated_at before update on public.conversations for each row execute function public.set_updated_at();
create trigger jobs_updated_at before update on public.jobs for each row execute function public.set_updated_at();
create trigger payment_records_updated_at before update on public.payment_records for each row execute function public.set_updated_at();
create trigger feedback_actions_updated_at before update on public.feedback_actions for each row execute function public.set_updated_at();

alter table public.app_users enable row level security;
alter table public.auth_sessions enable row level security;
alter table public.sep10_challenges enable row level security;
alter table public.conversations enable row level security;
alter table public.messages enable row level security;
alter table public.jobs enable row level security;
alter table public.payment_records enable row level security;
alter table public.feedback_actions enable row level security;
alter table public.audit_events enable row level security;

create policy "users read self" on public.app_users for select to authenticated using (id = auth.uid());
create policy "conversations own rows" on public.conversations for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "messages own rows" on public.messages for all to authenticated using (user_id = auth.uid()) with check (
  user_id = auth.uid() and exists (
    select 1 from public.conversations c where c.id = conversation_id and c.user_id = auth.uid()
  )
);
create policy "jobs read own rows" on public.jobs for select to authenticated using (user_id = auth.uid());
create policy "payments own rows" on public.payment_records for select to authenticated using (user_id = auth.uid());
create policy "feedback own rows" on public.feedback_actions for select to authenticated using (user_id = auth.uid());
create policy "audit own rows" on public.audit_events for select to authenticated using (user_id = auth.uid());

grant usage on schema public to anon, authenticated, service_role;
revoke all on all tables in schema public from anon, authenticated;
grant select on public.app_users to authenticated;
grant select, insert, update, delete on public.conversations to authenticated;
grant select, insert, update, delete on public.messages to authenticated;
grant select on public.jobs to authenticated;
grant select on public.payment_records, public.feedback_actions, public.audit_events to authenticated;
grant all on all tables in schema public to service_role;
grant usage, select on all sequences in schema public to service_role;

revoke all on public.auth_sessions from anon, authenticated;
revoke all on public.sep10_challenges from anon, authenticated;

create function public.algoria_claim_payment(p_payment_id uuid, p_signature_hash text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  claimed_job_id uuid;
begin
  select p.job_id into claimed_job_id
  from public.payment_records p
  join public.jobs j on j.id = p.job_id
  where p.id = p_payment_id
    and p.status = 'quoted'
    and p.quote_expires_at > now()
    and j.state = 'awaiting-payment'
  for update of p, j;

  if claimed_job_id is null then
    raise exception 'Payment quote is unavailable';
  end if;

  update public.payment_records
    set status = 'signed', payment_signature_hash = p_signature_hash
    where id = p_payment_id;
  update public.jobs set state = 'executing' where id = claimed_job_id;
  return claimed_job_id;
end;
$$;

create function public.algoria_cancel_payment_job(p_job_id uuid, p_user_id uuid) returns boolean
language plpgsql security definer set search_path = '' as $$
declare
  payment_id uuid;
begin
  select p.id into payment_id
  from public.jobs j
  join public.payment_records p on p.job_id = j.id
  where j.id = p_job_id
    and j.user_id = p_user_id
    and j.state = 'awaiting-payment'
    and p.status = 'quoted'
  for update of j, p;

  if payment_id is null then return false; end if;
  update public.jobs set state = 'cancelled' where id = p_job_id;
  update public.payment_records set status = 'expired' where id = payment_id;
  return true;
end;
$$;

revoke all on function public.algoria_claim_payment(uuid, text) from public, anon, authenticated;
revoke all on function public.algoria_cancel_payment_job(uuid, uuid) from public, anon, authenticated;
grant execute on function public.algoria_claim_payment(uuid, text) to service_role;
grant execute on function public.algoria_cancel_payment_job(uuid, uuid) to service_role;

create function public.algoria_apply_retention() returns void
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
  delete from public.auth_sessions where expires_at < now() or revoked_at < now() - interval '7 days';
  delete from public.sep10_challenges where expires_at < now() or consumed_at < now() - interval '1 day';
end;
$$;

revoke all on function public.algoria_apply_retention() from public, anon, authenticated;

select cron.schedule(
  'algoria-retention-daily',
  '17 3 * * *',
  $$select public.algoria_apply_retention();$$
);
