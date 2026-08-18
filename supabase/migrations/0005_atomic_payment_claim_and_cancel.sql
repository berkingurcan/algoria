create or replace function public.algoria_claim_payment(p_payment_id uuid, p_signature_hash text) returns uuid
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

create or replace function public.algoria_cancel_payment_job(p_job_id uuid, p_user_id uuid) returns boolean
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
