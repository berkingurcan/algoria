alter table public.jobs
  add column if not exists preparation_id uuid;

create unique index if not exists jobs_preparation_id_unique_idx
  on public.jobs(preparation_id)
  where preparation_id is not null;
