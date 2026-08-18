-- Publishing the source publishes the schema, the project ref and the
-- publishable key. None of those is a secret, and the posture already assumed
-- they were readable. What changes is that a reader no longer has to guess which
-- table holds session material, so every boundary that was correct-by-arrangement
-- is made correct-by-constraint here.

-- 1. Row level security was enabled everywhere but never forced, so the table
-- owner stayed exempt from its own policies. That is the default Postgres
-- behaviour and it is easy to read as a policy failure when it is not. But on
-- `auth_sessions.refresh_hash`, `sep10_challenges.challenge_hash` and
-- `provider_runs.recovery_token_hash` the difference is the one that matters.
--
-- This depends on one role attribute, so it is written down rather than assumed.
-- The three `security definer` functions here, `algoria_apply_retention`,
-- `algoria_claim_payment`, `algoria_cancel_payment_job`, execute as the table
-- owner, not as `service_role`, and every policy on these tables is `to
-- authenticated`. Forcing RLS removes the owner's ownership-based exemption, so
-- if the owner did not also hold `BYPASSRLS` those functions would quietly match
-- zero rows: retention would stop deleting and the payment claim would stop
-- claiming, both reporting success. On Supabase the owner is `postgres`, which
-- carries `BYPASSRLS`, so they keep working. Anyone running this schema
-- elsewhere must confirm the same before applying this migration:
--
--   select rolname, rolbypassrls from pg_roles where rolname = current_user;
--
-- `service_role` bypasses RLS through its own `BYPASSRLS` attribute, so the
-- application's server path is unaffected either way.
alter table public.app_users force row level security;
alter table public.auth_sessions force row level security;
alter table public.sep10_challenges force row level security;
alter table public.conversations force row level security;
alter table public.messages force row level security;
alter table public.jobs force row level security;
alter table public.payment_records force row level security;
alter table public.feedback_actions force row level security;
alter table public.audit_events force row level security;
alter table public.provider_runs force row level security;

-- 2. Migration 0001 revoked every table privilege from `anon` and
-- `authenticated`, but a revoke is a statement about the tables that existed
-- when it ran. Supabase's bootstrap leaves `alter default privileges ... grant
-- all on tables to anon, authenticated` standing, so the next table anyone adds
-- arrives readable and writable by a role whose key is published on purpose.
-- `provider_runs` only escaped that because 0006 happened to carry its own
-- revoke. In a public repository the next migration may well come from someone
-- who has never read 0001, so the default itself has to change.
--
-- Stated precisely, because a default ACL is per granting role: this changes the
-- default for objects created by the role that runs migrations, which is the role
-- every later migration in this directory also runs as. The platform keeps a
-- second default under `supabase_admin` that a migration cannot alter, so an
-- object created through the dashboard by that role is still not covered here.
-- The table-level revokes above remain the backstop for anything that arrives by
-- another path.
alter default privileges in schema public revoke all on tables from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;
-- `public` has to be named for functions and only for functions. Postgres itself
-- grants EXECUTE on every new function to PUBLIC, and both roles inherit from it,
-- so revoking from the two roles by name leaves the privilege sitting in the
-- default they inherit. 0001 states the same rule at its own function grants, and
-- 0009 restates it; tables and sequences have no built-in PUBLIC default, which is
-- why they do not need it.
alter default privileges in schema public revoke all on functions from public, anon, authenticated;

-- 3. 0009 pinned `set_updated_at` and claimed every other function was already
-- pinned. That was not true of `algoria_apply_retention`, and 0010 then re-created
-- it with `search_path = public`, which Postgres searches *after* an implicit
-- `pg_temp`, so a temporary object can shadow an unqualified name. The body is
-- fully schema-qualified today, so this is not exploitable now; it runs as the
-- owner, which is why it should not depend on staying that way. The body is
-- unchanged from 0010.
create or replace function public.algoria_apply_retention() returns void
language plpgsql security definer set search_path = '' as $$
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

-- 4. `conversations` and `messages` were the only two tables `authenticated` could
-- write, and their policies constrain ownership alone, not `role`, not `kind`,
-- not `content`. A client that reached PostgREST with an accepted token could
-- therefore insert a `kind='job'` message asserting a finished job and a
-- settled payment, which the server reads back and renders. Nothing needs these
-- grants: no browser Supabase client exists in this application, the publishable
-- key is read by no code, and every write goes through the server's secret-key
-- client. Read access stays, so the grant now matches what is actually used.
revoke insert, update, delete on public.conversations from authenticated;
revoke insert, update, delete on public.messages from authenticated;

-- The grant is only half of it. Both tables still carry `for all` policies from
-- 0001, and 0003, the file whose whole job is to be the explicit grant list,
-- still spells out `grant select, insert, update, delete`. So the two files now
-- disagree, and the obvious way to add a table later is to copy 0003's block,
-- which would hand the writes straight back. Narrowing the policies makes the
-- restriction hold on its own: a future grant alone would no longer be enough.
drop policy if exists "conversations own rows" on public.conversations;
drop policy if exists "messages own rows" on public.messages;
create policy "conversations own rows" on public.conversations
  for select to authenticated using (user_id = auth.uid());
create policy "messages own rows" on public.messages
  for select to authenticated using (user_id = auth.uid());

-- 5. No size constraint is added to `messages.content`, and the reason is worth
-- recording because the obvious reading says there should be one. It was
-- unbounded jsonb while `conversations.title` beside it was bounded, which looked
-- like an oversight. It was only reachable as a storage-exhaustion vector while a
-- client could write the table, and step 4 above removed that. The sole remaining
-- writer is the server's own secret-key client, and a check constraint applies to
-- it too: an oversized Job Card snapshot would fail its insert with a bare 23514
-- that no caller distinguishes from any other database error, so a job that had
-- executed and settled would report a generic failure instead of its result. A
-- bound worth having belongs where the snapshot is built, with a message the user
-- can act on, not here, where it can only turn a delivered result into an error.
