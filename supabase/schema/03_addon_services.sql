-- =====================================================================
-- 03_addon_services.sql  |  Add-on services (+ photos)
-- Requires 01_users.sql and 02_motorbikes.sql. First-time setup.
-- =====================================================================

-- ---------- Table -------------------------------------------------------
-- description_kh = Khmer description. photo_path = object path inside
-- Storage bucket 'addon-service-photos'.
-- On insert, updated_by / updated_at equal the creator's info (set by trigger).
create table if not exists public.addon_services (
  id              uuid primary key default gen_random_uuid(),
  description     text not null check (length(trim(description)) > 0),
  description_kh  text,
  photo_path      text,
  remark          text,
  is_active       boolean not null default true,
  created_at      timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  created_by      uuid references public.users (id),
  updated_by     uuid references public.users (id)
);

-- Same description cannot be added twice (case-insensitive).
create unique index if not exists addon_services_description_uq
  on public.addon_services (lower(trim(description)));

drop trigger if exists trg_addon_services_audit on public.addon_services;
create trigger trg_addon_services_audit
  before insert or update on public.addon_services
  for each row execute function public.set_audit_columns();

-- ---------- Row Level Security -----------------------------------------
-- Everyone logged in can read; only can_manage_catalog() can write.
alter table public.addon_services enable row level security;

drop policy if exists addon_services_select on public.addon_services;
create policy addon_services_select on public.addon_services
  for select to authenticated using (true);

drop policy if exists addon_services_insert on public.addon_services;
create policy addon_services_insert on public.addon_services
  for insert to authenticated with check (public.can_manage_catalog());

drop policy if exists addon_services_update on public.addon_services;
create policy addon_services_update on public.addon_services
  for update to authenticated
  using (public.can_manage_catalog()) with check (public.can_manage_catalog());

drop policy if exists addon_services_delete on public.addon_services;
create policy addon_services_delete on public.addon_services
  for delete to authenticated using (public.can_manage_catalog());

revoke all on public.addon_services from anon;
grant select, insert, update, delete on public.addon_services to authenticated;

-- ---------- Photo storage ----------------------------------------------
-- Public bucket so <img src> works without signed URLs. Max 2 MB, images only.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('addon-service-photos', 'addon-service-photos', true, 2097152,
        array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists addon_photos_select on storage.objects;
create policy addon_photos_select on storage.objects
  for select to authenticated
  using (bucket_id = 'addon-service-photos');

drop policy if exists addon_photos_insert on storage.objects;
create policy addon_photos_insert on storage.objects
  for insert to authenticated
  with check (bucket_id = 'addon-service-photos' and public.can_manage_catalog());

drop policy if exists addon_photos_update on storage.objects;
create policy addon_photos_update on storage.objects
  for update to authenticated
  using (bucket_id = 'addon-service-photos' and public.can_manage_catalog())
  with check (bucket_id = 'addon-service-photos' and public.can_manage_catalog());

drop policy if exists addon_photos_delete on storage.objects;
create policy addon_photos_delete on storage.objects
  for delete to authenticated
  using (bucket_id = 'addon-service-photos' and public.can_manage_catalog());
