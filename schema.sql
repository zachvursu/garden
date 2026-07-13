-- The Garden — Supabase schema
-- Run this once in your Supabase project: Dashboard → SQL Editor → New query → paste → Run.
--
-- Design: one generic "records" table holds every structured record (entries,
-- plants, beds, supplies, kv) as a JSON blob keyed by (store, id). This means the
-- app can add new fields later without any schema change. Media (photos, voice
-- memos) live in a Storage bucket, not here.

-- 1) The records table -------------------------------------------------------
create table if not exists public.records (
  store      text        not null,             -- 'entries' | 'plants' | 'beds' | 'supplies' | 'kv'
  id         text        not null,             -- the record's own id (or the kv key)
  data       jsonb       not null,             -- the full record
  deleted    boolean     not null default false,
  updated_at timestamptz not null default now(),
  primary key (store, id)
);

-- keep updated_at fresh on every write
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

drop trigger if exists records_touch on public.records;
create trigger records_touch
  before update on public.records
  for each row execute function public.touch_updated_at();

-- fast "what changed since I last synced" pulls
create index if not exists records_updated_at_idx on public.records (updated_at);

-- 2) Access ------------------------------------------------------------------
-- No login (per your call: nothing here is private). Row Level Security is ON,
-- with a single permissive policy so the public "anon" key can read/write.
-- If you ever add login later, replace this policy with a per-user one.
alter table public.records enable row level security;

drop policy if exists records_anon_all on public.records;
create policy records_anon_all
  on public.records
  for all
  to anon
  using (true)
  with check (true);

-- 3) Realtime (so a change on your phone shows up on your laptop live) --------
alter publication supabase_realtime add table public.records;

-- 4) Media bucket (photos + voice memos) -------------------------------------
insert into storage.buckets (id, name, public)
values ('media', 'media', true)
on conflict (id) do nothing;

-- anon can read/write files in the media bucket (matches the no-login setup)
drop policy if exists "media anon read"   on storage.objects;
drop policy if exists "media anon insert" on storage.objects;
drop policy if exists "media anon update" on storage.objects;
drop policy if exists "media anon delete" on storage.objects;

create policy "media anon read"   on storage.objects for select to anon using (bucket_id = 'media');
create policy "media anon insert" on storage.objects for insert to anon with check (bucket_id = 'media');
create policy "media anon update" on storage.objects for update to anon using (bucket_id = 'media') with check (bucket_id = 'media');
create policy "media anon delete" on storage.objects for delete to anon using (bucket_id = 'media');
