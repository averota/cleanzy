-- =====================================================================
-- 01_users.sql  |  Users, roles & permissions
-- Run in Supabase SQL Editor (or as a migration). First-time setup.
-- =====================================================================

-- ---------- Role enum ------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_type where typname = 'user_role') then
    create type public.user_role as enum ('Admin', 'Store Manager', 'Clerk');
  end if;
end $$;

-- ---------- Users table ----------------------------------------------
-- One row per auth user, EXCEPT the Super Admin (never stored here).
-- created_by / updated_by: NULL = Super Admin (displayed as "Admin").
create table if not exists public.users (
  id          uuid primary key references auth.users (id) on delete cascade,
  name        text not null check (length(trim(name)) > 0),
  position    text,
  email       text not null unique,
  role        public.user_role not null,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  created_by  uuid references public.users (id),
  updated_by  uuid references public.users (id)
);

create index if not exists users_role_idx on public.users (role);

-- ---------- Helper functions -----------------------------------------
-- Super Admin = auth user whose app_metadata.role = 'super_admin'
-- (app_metadata can only be changed server-side, so users cannot fake it).
create or replace function public.is_super_admin()
returns boolean
language sql stable
as $$
  select coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '') = 'super_admin';
$$;

-- Role of the logged-in user (NULL for Super Admin or unknown/inactive user).
create or replace function public.current_user_role()
returns public.user_role
language sql stable security definer
set search_path = public
as $$
  select role from public.users where id = auth.uid() and is_active;
$$;

create or replace function public.is_admin()
returns boolean
language sql stable
as $$
  select coalesce(public.current_user_role() = 'Admin', false);
$$;

-- Display name for change tracking: NULL actor => "Admin" (Super Admin).
create or replace function public.actor_name(actor uuid)
returns text
language sql stable security definer
set search_path = public
as $$
  select case when actor is null then 'Admin'
              else (select name from public.users where id = actor) end;
$$;

-- Generic audit trigger function, reusable by any table with
-- created_at / updated_at / created_by / updated_by columns.
-- NULL actor = Super Admin (displayed as "Admin").
create or replace function public.set_audit_columns()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  actor uuid := case when public.is_super_admin() then null else auth.uid() end;
begin
  new.updated_at := now();
  new.updated_by := actor;

  if tg_op = 'INSERT' then
    new.created_by := actor;
  else
    new.created_at := old.created_at;
    new.created_by := old.created_by;
  end if;

  return new;
end $$;

-- ---------- Audit / integrity trigger --------------------------------
-- SECURITY DEFINER so it can read auth.users (callers have no access to it).
create or replace function public.users_before_write()
returns trigger
language plpgsql security definer
set search_path = public, auth
as $$
declare
  actor uuid := case when public.is_super_admin() then null else auth.uid() end;
begin
  -- Super Admin must never have a row in this table.
  if exists (
    select 1 from auth.users
    where id = new.id
      and coalesce(raw_app_meta_data ->> 'role', '') = 'super_admin'
  ) then
    raise exception 'Super Admin cannot be stored in public.users';
  end if;

  new.email := lower(trim(new.email));
  new.updated_at := now();
  new.updated_by := actor;

  if tg_op = 'INSERT' then
    new.created_by := actor;
  else
    new.created_at := old.created_at;
    new.created_by := old.created_by;
  end if;

  return new;
end $$;

drop trigger if exists trg_users_before_write on public.users;
create trigger trg_users_before_write
  before insert or update on public.users
  for each row execute function public.users_before_write();

-- ---------- Row Level Security ---------------------------------------
-- Super Admin and Admin manage all users; others can only read their own row.
alter table public.users enable row level security;

drop policy if exists users_select on public.users;
create policy users_select on public.users
  for select to authenticated
  using (public.is_super_admin() or public.is_admin() or id = auth.uid());

drop policy if exists users_insert on public.users;
create policy users_insert on public.users
  for insert to authenticated
  with check (public.is_super_admin() or public.is_admin());

drop policy if exists users_update on public.users;
create policy users_update on public.users
  for update to authenticated
  using (public.is_super_admin() or public.is_admin())
  with check (public.is_super_admin() or public.is_admin());

drop policy if exists users_delete on public.users;
create policy users_delete on public.users
  for delete to authenticated
  using (public.is_super_admin() or public.is_admin());

revoke all on public.users from anon;
grant select, insert, update, delete on public.users to authenticated;

-- ---------- Permissions ----------------------------------------------
-- Super Admin and Admin always have every permission.
-- Admin decides what Store Manager and Clerk can do via role_permissions.
-- To add a permission later: insert a row into public.permissions (Super Admin only).
create table if not exists public.permissions (
  key         text primary key check (key = lower(trim(key)) and length(key) > 0),
  label       text not null,
  description text,
  sort_order  smallint not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  created_by  uuid references public.users (id),
  updated_by  uuid references public.users (id)
);

drop trigger if exists trg_permissions_audit on public.permissions;
create trigger trg_permissions_audit
  before insert or update on public.permissions
  for each row execute function public.set_audit_columns();

insert into public.permissions (key, label, description, sort_order) values
  ('manage_catalog', 'Manage catalog',  'Add, edit and delete product categories, sizes, models and photos', 1),
  ('manage_price',   'Manage price',    'Add, edit and delete service prices',                               2),
  ('enter_revenue',  'Enter revenue',   'Record revenue entries',                                            3),
  ('view_report',    'View report',     'View revenue reports',                                              4),
  ('confirm_revenue','Confirm revenue', 'Confirm pending sales (confirmed sales can no longer be voided)',     5),
  ('backdate_revenue','Back-date revenue','Enter sales dated before today',                                     6)
on conflict (key) do update
  set label = excluded.label,
      description = excluded.description,
      sort_order = excluded.sort_order
  where (permissions.label, permissions.description, permissions.sort_order)
        is distinct from (excluded.label, excluded.description, excluded.sort_order);

-- A row = permission granted to that role. No row = not granted.
create table if not exists public.role_permissions (
  role            public.user_role not null check (role in ('Store Manager', 'Clerk')),
  permission_key  text not null references public.permissions (key)
                    on update cascade on delete cascade,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  created_by      uuid references public.users (id),
  updated_by      uuid references public.users (id),
  primary key (role, permission_key)
);

drop trigger if exists trg_role_permissions_audit on public.role_permissions;
create trigger trg_role_permissions_audit
  before insert or update on public.role_permissions
  for each row execute function public.set_audit_columns();

-- Default grant: Store Manager can confirm sales. Admin can change this later.
-- Seeds only while role_permissions is completely empty, so re-running this file
-- never overrides grants that Admin has already set.
insert into public.role_permissions (role, permission_key)
select 'Store Manager', 'confirm_revenue'
where not exists (select 1 from public.role_permissions);

-- Does the logged-in user hold this permission? (use in RLS policies)
create or replace function public.has_permission(p_key text)
returns boolean
language sql stable
as $$
  select public.is_super_admin()
      or public.is_admin()
      or exists (
        select 1 from public.role_permissions rp
        where rp.role = public.current_user_role()
          and rp.permission_key = p_key
      );
$$;

-- Permission keys of the logged-in user (for the front-end to show/hide features).
create or replace function public.my_permissions()
returns setof text
language sql stable
as $$
  select p.key
  from public.permissions p
  where public.is_super_admin()
     or public.is_admin()
     or p.key in (
       select rp.permission_key from public.role_permissions rp
       where rp.role = public.current_user_role()
     )
  order by p.sort_order;
$$;

alter table public.permissions      enable row level security;
alter table public.role_permissions enable row level security;

-- Definitions: everyone logged in can read; only Super Admin can change.
drop policy if exists permissions_select on public.permissions;
create policy permissions_select on public.permissions
  for select to authenticated using (true);

drop policy if exists permissions_write on public.permissions;
create policy permissions_write on public.permissions
  for all to authenticated
  using (public.is_super_admin()) with check (public.is_super_admin());

-- Role grants: everyone logged in can read; Super Admin and Admin can change.
drop policy if exists role_permissions_select on public.role_permissions;
create policy role_permissions_select on public.role_permissions
  for select to authenticated using (true);

drop policy if exists role_permissions_write on public.role_permissions;
create policy role_permissions_write on public.role_permissions
  for all to authenticated
  using (public.is_super_admin() or public.is_admin())
  with check (public.is_super_admin() or public.is_admin());

revoke all on public.permissions, public.role_permissions from anon;
grant select, insert, update, delete on public.permissions, public.role_permissions to authenticated;

-- =====================================================================
-- ONE-TIME SETUP: create the Super Admin
-- 1) Supabase Dashboard > Authentication > Users > Add user (email + password).
-- 2) Run the statement below with that email. Do NOT insert into public.users.
--
-- update auth.users
--    set raw_app_meta_data = coalesce(raw_app_meta_data, '{}'::jsonb)
--                            || '{"role": "super_admin"}'::jsonb
--  where email = 'your-superadmin@email.com';
-- =====================================================================
