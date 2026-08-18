-- A quote whose deadline has passed can never be claimed: the claim RPC requires
-- both `quoted` and an unexpired timestamp. But nothing moved such a row out of
-- `quoted`, because the browser refuses an expired quote before it ever reaches
-- the server, so the status said "quoted" long after the quote had died.
--
-- Retention now settles that. It only relabels rows the claim path had already
-- stopped honouring, so no payment becomes any more or less possible; the record
-- simply stops claiming to be live. The Job is left in `awaiting-payment`, which
-- remains true, and the user can still cancel it or request a fresh quote.
create or replace function public.algoria_apply_retention() returns void
language plpgsql security definer set search_path = public as $$
begin
  update public.payment_records
    set status = 'expired'
    where status = 'quoted' and quote_expires_at < now();

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
