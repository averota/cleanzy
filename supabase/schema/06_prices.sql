-- =====================================================================
-- 06_prices.sql  |  Price history for all products & services + USD/KHR exchange rates
-- Requires 01_users.sql, 02_motorbikes.sql, 03_addon_services.sql,
-- 04_helmet_services.sql, 05_food_drinks.sql. First-time setup.
-- =====================================================================
-- PRICES (append-only): a price is never edited or deleted. To change a price,
-- insert a new row; the latest row whose effective_from <= now() is the current price.
-- Revenue records should store the price row id (and/or amount) at entry time,
-- so later price changes never alter past revenue.
--
-- Each price row prices exactly ONE target:
--   motorbike_size_id  -> motorbike wash price per size (applies to all models of that size;
--                         wash is the default service, no separate wash types for now)
--   addon_service_id   -> add-on service
--   helmet_service_id  -> helmet service
--   food_drink_item_id -> food / drink item
--
-- EXCHANGE RATES (append-only): rate = KHR for 1 USD (e.g. 4100).
--   FIXED rate     -> insert one rate and never add another.
--   CHANGING rate  -> insert a new rate whenever it changes.
-- Amounts stay in the currency they were entered in. Revenue records should
-- store the rate (or rate id) used at entry time, so changing the rate never
-- alters past reports.

-- ---------- Shared trigger function ------------------------------------
-- No back-dating: effective_from can be now or a future time (scheduled change),
-- never in the past, so history stays accurate. Exception: Super Admin may enter
-- a past effective_from (e.g. to record a price/rate that was missed). Past sales
-- are not affected because they store the price/rate they used.
-- Generic: reusable by any table with an effective_from column.
create or replace function public.enforce_effective_from()
returns trigger
language plpgsql
as $$
begin
  if public.is_super_admin() then
    new.effective_from := coalesce(new.effective_from, now());
  else
    new.effective_from := greatest(coalesce(new.effective_from, now()), now());
  end if;
  return new;
end $$;

-- =====================================================================
-- PRICES
-- =====================================================================

-- ---------- Table -------------------------------------------------------
create table if not exists public.prices (
  id                  uuid primary key default gen_random_uuid(),
  motorbike_size_id   smallint references public.motorbike_sizes (id),
  addon_service_id    uuid references public.addon_services (id),
  helmet_service_id   uuid references public.helmet_services (id),
  food_drink_item_id  uuid references public.food_drink_items (id),
  amount              numeric(12, 2) not null check (amount >= 0),
  currency            text not null default 'USD' check (currency in ('USD', 'KHR')),
  effective_from      timestamptz not null default now(),
  remark              text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  created_by          uuid references public.users (id),
  updated_by          uuid references public.users (id),
  constraint prices_one_target_chk
    check (num_nonnulls(motorbike_size_id, addon_service_id,
                        helmet_service_id, food_drink_item_id) = 1)
);

-- One price per target per effective time; these also speed up "latest price" lookups.
create unique index if not exists prices_motorbike_size_uq
  on public.prices (motorbike_size_id, effective_from desc) where motorbike_size_id is not null;
create unique index if not exists prices_addon_service_uq
  on public.prices (addon_service_id, effective_from desc) where addon_service_id is not null;
create unique index if not exists prices_helmet_service_uq
  on public.prices (helmet_service_id, effective_from desc) where helmet_service_id is not null;
create unique index if not exists prices_food_drink_item_uq
  on public.prices (food_drink_item_id, effective_from desc) where food_drink_item_id is not null;

-- ---------- Triggers ---------------------------------------------------
drop trigger if exists trg_prices_effective on public.prices;
create trigger trg_prices_effective
  before insert on public.prices
  for each row execute function public.enforce_effective_from();

drop trigger if exists trg_prices_audit on public.prices;
create trigger trg_prices_audit
  before insert or update on public.prices
  for each row execute function public.set_audit_columns();

-- ---------- Current price view ------------------------------------------
-- Latest price per target that is already in effect.
create or replace view public.current_prices
with (security_invoker = true) as
select distinct on (motorbike_size_id, addon_service_id, helmet_service_id, food_drink_item_id)
       id, motorbike_size_id, addon_service_id, helmet_service_id, food_drink_item_id,
       amount, currency, effective_from, remark
from public.prices
where effective_from <= now()
order by motorbike_size_id, addon_service_id, helmet_service_id, food_drink_item_id,
         effective_from desc;

-- =====================================================================
-- EXCHANGE RATES
-- =====================================================================

-- ---------- Table -------------------------------------------------------
create table if not exists public.exchange_rates (
  id              uuid primary key default gen_random_uuid(),
  usd_to_khr      numeric(12, 2) not null check (usd_to_khr > 0),
  effective_from  timestamptz not null default now(),
  remark          text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  created_by      uuid references public.users (id),
  updated_by      uuid references public.users (id)
);

create unique index if not exists exchange_rates_effective_from_uq
  on public.exchange_rates (effective_from desc);

-- ---------- Triggers ---------------------------------------------------
drop trigger if exists trg_exchange_rates_effective on public.exchange_rates;
create trigger trg_exchange_rates_effective
  before insert on public.exchange_rates
  for each row execute function public.enforce_effective_from();

drop trigger if exists trg_exchange_rates_audit on public.exchange_rates;
create trigger trg_exchange_rates_audit
  before insert or update on public.exchange_rates
  for each row execute function public.set_audit_columns();

-- ---------- Current rate view & lookup ----------------------------------
-- Latest rate already in effect (0 or 1 row; empty until the first rate is added).
create or replace view public.current_exchange_rate
with (security_invoker = true) as
select id, usd_to_khr, effective_from, remark
from public.exchange_rates
where effective_from <= now()
order by effective_from desc
limit 1;

-- Rate that was in effect at a given time (NULL if none yet).
create or replace function public.exchange_rate_at(p_at timestamptz default now())
returns numeric
language sql stable
as $$
  select usd_to_khr
  from public.exchange_rates
  where effective_from <= p_at
  order by effective_from desc
  limit 1;
$$;

-- =====================================================================
-- ROW LEVEL SECURITY (both tables)
-- =====================================================================
-- Everyone logged in can read; only 'manage_price' holders can insert.
-- No update/delete policies or grants: history is permanent.
do $$
declare t text;
begin
  foreach t in array array['prices', 'exchange_rates'] loop
    execute format('alter table public.%I enable row level security', t);

    execute format('drop policy if exists %I on public.%I', t || '_select', t);
    execute format('create policy %I on public.%I for select to authenticated using (true)',
                   t || '_select', t);

    execute format('drop policy if exists %I on public.%I', t || '_insert', t);
    execute format('create policy %I on public.%I for insert to authenticated with check (public.has_permission(''manage_price''))',
                   t || '_insert', t);

    execute format('drop policy if exists %I on public.%I', t || '_update', t);
    execute format('drop policy if exists %I on public.%I', t || '_delete', t);

    execute format('revoke all on public.%I from anon', t);
    execute format('revoke all on public.%I from authenticated', t);
    execute format('grant select, insert on public.%I to authenticated', t);
  end loop;
end $$;

revoke all on public.current_prices, public.current_exchange_rate from anon;
grant select on public.current_prices, public.current_exchange_rate to authenticated;
