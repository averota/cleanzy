-- =====================================================================
-- 02_motorbikes.sql  |  Product category: Motorbike (sizes + models + photos)
-- Requires 01_users.sql (users, permissions, set_audit_columns). First-time setup.
-- =====================================================================

-- ---------- Catalog permission -----------------------------------------
-- Controlled by Admin via role_permissions ('manage_catalog'). See 01_users.sql.
create or replace function public.can_manage_catalog()
returns boolean
language sql stable
as $$
  select public.has_permission('manage_catalog');
$$;

-- ---------- Sizes ------------------------------------------------------
create table if not exists public.motorbike_sizes (
  id          smallint generated always as identity primary key,
  code        text not null unique check (code = upper(trim(code)) and length(code) > 0),
  sort_order  smallint not null default 0,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  created_by  uuid references public.users (id),
  updated_by  uuid references public.users (id)
);

-- Initial seed only. Sizes are managed from the front-end afterwards,
-- so do not re-run this statement once you start editing sizes there.
insert into public.motorbike_sizes (code, sort_order) values
  ('XS', 1), ('S', 2), ('M', 3), ('L', 4), ('2L', 5), ('3L', 6),
  ('XL', 7), ('2XL', 8), ('3XL', 9)
on conflict (code) do update set sort_order = excluded.sort_order
  where motorbike_sizes.sort_order is distinct from excluded.sort_order;

-- ---------- Models -----------------------------------------------------
-- photo_path = object path inside Storage bucket 'motorbike-photos'.
create table if not exists public.motorbike_models (
  id          uuid primary key default gen_random_uuid(),
  size_id     smallint not null references public.motorbike_sizes (id),
  brand       text not null check (length(trim(brand)) > 0),
  model       text not null check (length(trim(model)) > 0),
  photo_path  text,
  remarks     text,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  created_by  uuid references public.users (id),
  updated_by  uuid references public.users (id)
);

-- Same brand + model cannot be added twice under the same size (case-insensitive).
create unique index if not exists motorbike_models_brand_model_size_uq
  on public.motorbike_models (lower(trim(brand)), lower(trim(model)), size_id);

create index if not exists motorbike_models_size_idx on public.motorbike_models (size_id);

-- ---------- Audit triggers ---------------------------------------------
drop trigger if exists trg_motorbike_sizes_audit on public.motorbike_sizes;
create trigger trg_motorbike_sizes_audit
  before insert or update on public.motorbike_sizes
  for each row execute function public.set_audit_columns();

drop trigger if exists trg_motorbike_models_audit on public.motorbike_models;
create trigger trg_motorbike_models_audit
  before insert or update on public.motorbike_models
  for each row execute function public.set_audit_columns();

-- ---------- Row Level Security -----------------------------------------
-- Everyone logged in can read; only can_manage_catalog() can write.
do $$
declare t text;
begin
  foreach t in array array['motorbike_sizes', 'motorbike_models'] loop
    execute format('alter table public.%I enable row level security', t);

    execute format('drop policy if exists %I on public.%I', t || '_select', t);
    execute format('create policy %I on public.%I for select to authenticated using (true)',
                   t || '_select', t);

    execute format('drop policy if exists %I on public.%I', t || '_insert', t);
    execute format('create policy %I on public.%I for insert to authenticated with check (public.can_manage_catalog())',
                   t || '_insert', t);

    execute format('drop policy if exists %I on public.%I', t || '_update', t);
    execute format('create policy %I on public.%I for update to authenticated using (public.can_manage_catalog()) with check (public.can_manage_catalog())',
                   t || '_update', t);

    execute format('drop policy if exists %I on public.%I', t || '_delete', t);
    execute format('create policy %I on public.%I for delete to authenticated using (public.can_manage_catalog())',
                   t || '_delete', t);

    execute format('revoke all on public.%I from anon', t);
    execute format('grant select, insert, update, delete on public.%I to authenticated', t);
  end loop;
end $$;

-- ---------- Photo storage ----------------------------------------------
-- Public bucket so <img src> works without signed URLs. Max 2 MB, images only.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('motorbike-photos', 'motorbike-photos', true, 2097152,
        array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists motorbike_photos_select on storage.objects;
create policy motorbike_photos_select on storage.objects
  for select to authenticated
  using (bucket_id = 'motorbike-photos');

drop policy if exists motorbike_photos_insert on storage.objects;
create policy motorbike_photos_insert on storage.objects
  for insert to authenticated
  with check (bucket_id = 'motorbike-photos' and public.can_manage_catalog());

drop policy if exists motorbike_photos_update on storage.objects;
create policy motorbike_photos_update on storage.objects
  for update to authenticated
  using (bucket_id = 'motorbike-photos' and public.can_manage_catalog())
  with check (bucket_id = 'motorbike-photos' and public.can_manage_catalog());

drop policy if exists motorbike_photos_delete on storage.objects;
create policy motorbike_photos_delete on storage.objects
  for delete to authenticated
  using (bucket_id = 'motorbike-photos' and public.can_manage_catalog());
