revoke all on all tables in schema public from anon, authenticated;

grant select on public.app_users to authenticated;
grant select, insert, update, delete on public.conversations to authenticated;
grant select, insert, update, delete on public.messages to authenticated;
grant select on public.jobs to authenticated;
grant select on public.payment_records, public.feedback_actions, public.audit_events to authenticated;
