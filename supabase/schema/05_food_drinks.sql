-- =====================================================================
-- 05_food_drinks.sql  |  Product category: Food & Drink (categories + items + photos)
-- Requires 01_users.sql (users, permissions, set_audit_columns) and
-- 02_motorbikes.sql (can_manage_catalog). First-time setup.
-- =====================================================================

-- ---------- Categories -------------------------------------------------
-- kind separates Food from Drink so both live in the same tables.
-- Examples: Food > Snack | Drink > Frappe, Iced, Soda, Hot, Smoothie.
-- name_kh = Khmer name.
create table if not exists public.food_drink_categories (
  id          smallint generated always as identity primary key,
  kind        text not null check (kind in ('Food', 'Drink')),
  name        text not null check (length(trim(name)) > 0),
  name_kh     text,
  sort_order  smallint not null default 0,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  created_by  uuid references public.users (id),
  updated_by  uuid references public.users (id)
);

-- Same name cannot be added twice under the same kind (case-insensitive).
create unique index if not exists food_drink_categories_kind_name_uq
  on public.food_drink_categories (kind, lower(trim(name)));

-- Initial seed only. Categories are managed from the front-end afterwards,
-- so do not re-run this statement once you start editing categories there.
insert into public.food_drink_categories (kind, name, sort_order) values
  ('Food',  'Snack',    1),
  ('Drink', 'Frappe',   2),
  ('Drink', 'Iced',     3),
  ('Drink', 'Soda',     4),
  ('Drink', 'Hot',      5),
  ('Drink', 'Smoothie', 6)
on conflict do nothing;

-- ---------- Items ------------------------------------------------------
-- description_kh = Khmer description. photo_path = object path inside
-- Storage bucket 'food-drink-photos'.
create table if not exists public.food_drink_items (
  id              uuid primary key default gen_random_uuid(),
  category_id     smallint not null references public.food_drink_categories (id),
  description     text not null check (length(trim(description)) > 0),
  description_kh  text,
  photo_path      text,
  remark          text,
  is_active       boolean not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  created_by      uuid references public.users (id),
  updated_by      uuid references public.users (id)
);

-- Same description cannot be added twice under the same category (case-insensitive).
create unique index if not exists food_drink_items_category_description_uq
  on public.food_drink_items (category_id, lower(trim(description)));

create index if not exists food_drink_items_category_idx
  on public.food_drink_items (category_id);

-- ---------- Audit triggers ---------------------------------------------
drop trigger if exists trg_food_drink_categories_audit on public.food_drink_categories;
create trigger trg_food_drink_categories_audit
  before insert or update on public.food_drink_categories
  for each row execute function public.set_audit_columns();

drop trigger if exists trg_food_drink_items_audit on public.food_drink_items;
create trigger trg_food_drink_items_audit
  before insert or update on public.food_drink_items
  for each row execute function public.set_audit_columns();

-- ---------- Row Level Security -----------------------------------------
-- Everyone logged in can read; only can_manage_catalog() can write.
do $$
declare t text;
begin
  foreach t in array array['food_drink_categories', 'food_drink_items'] loop
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
values ('food-drink-photos', 'food-drink-photos', true, 2097152,
        array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists food_drink_photos_select on storage.objects;
create policy food_drink_photos_select on storage.objects
  for select to authenticated
  using (bucket_id = 'food-drink-photos');

drop policy if exists food_drink_photos_insert on storage.objects;
create policy food_drink_photos_insert on storage.objects
  for insert to authenticated
  with check (bucket_id = 'food-drink-photos' and public.can_manage_catalog());

drop policy if exists food_drink_photos_update on storage.objects;
create policy food_drink_photos_update on storage.objects
  for update to authenticated
  using (bucket_id = 'food-drink-photos' and public.can_manage_catalog())
  with check (bucket_id = 'food-drink-photos' and public.can_manage_catalog());

drop policy if exists food_drink_photos_delete on storage.objects;
create policy food_drink_photos_delete on storage.objects
  for delete to authenticated
  using (bucket_id = 'food-drink-photos' and public.can_manage_catalog());
