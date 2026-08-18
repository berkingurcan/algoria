alter type public.job_state add value if not exists 'payment-uncertain';

alter table public.payment_records
  add column if not exists quote_expires_at timestamptz;

update public.payment_records
set quote_expires_at = expires_at
where quote_expires_at is null;

alter table public.payment_records
  alter column quote_expires_at set not null;

alter table public.payment_records
  drop constraint if exists payment_records_status_check;

alter table public.payment_records
  add constraint payment_records_status_check
  check (status in ('quoted', 'signed', 'reconciling', 'settled', 'failed', 'expired'));

update public.payment_records
set expires_at = created_at + interval '365 days'
where expires_at < created_at + interval '365 days';

create index if not exists payment_records_quote_expiry_idx
  on public.payment_records(quote_expires_at);

drop policy if exists "jobs own rows" on public.jobs;
drop policy if exists "jobs read own rows" on public.jobs;
create policy "jobs read own rows" on public.jobs
  for select to authenticated using (user_id = auth.uid());

revoke insert, update, delete on public.jobs from authenticated;
grant select on public.jobs to authenticated;
