-- Pin the trigger function's schema resolution. `now()` lives in pg_catalog,
-- which is always in scope, so an empty search_path changes nothing at runtime
-- while removing the chance that a shadowing schema resolves the name instead.
-- Every other function here already does this; this one was missed.
create or replace function public.set_updated_at() returns trigger
language plpgsql security invoker set search_path = '' as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- The platform's auto-RLS helper is an event trigger function, so it cannot be
-- invoked as an RPC at all, because an event trigger runs as its owner and never
-- through EXECUTE. The grant it ships with is therefore unused surface that
-- shows up in security linting. Dropped where present; absent locally.
do $$
begin
  if exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'rls_auto_enable'
  ) then
    -- PUBLIC must go too: anon and authenticated inherit EXECUTE from it, so
    -- naming them alone leaves the privilege in place.
    revoke execute on function public.rls_auto_enable() from public, anon, authenticated;
  end if;
end
$$;
