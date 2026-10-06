-- =====================================================================
-- 07_sales.sql  |  Revenue: sales (receipts) + sale items
-- Requires 01_users.sql (incl. 'confirm_revenue' and 'backdate_revenue' permissions)
-- through 06_prices.sql. First-time setup.
-- =====================================================================
-- HOW IT WORKS
-- * One sale (receipt) has many items (motorbike, add-on, helmet, food/drink).
-- * The front-end never writes to these tables directly. It calls:
--     create_sale(...)  -> looks up the current price, converts USD to KHR with
--                          the current exchange rate, applies discounts, rounds
--                          DOWN to the nearest 100 riel, and saves everything.
--     confirm_sale(id)  -> needs 'confirm_revenue' permission. Pending -> Confirmed.
--     update_sale(id, ...)  -> Super Admin only. Edits header + items of a Pending or
--                          Confirmed sale (see update_sale below).
--     void_sale(id, reason) -> Pending -> Voided. Confirmed sales can only be voided
--                          by Super Admin (reason required, confirmation record is kept).
-- * All amounts are stored in KHR. The price row id and exchange rate used are
--   saved with the sale, so later price/rate changes never alter past reports.
-- * Sales cannot be deleted. Normal users cannot edit them either: to correct a mistake,
--   void it (while Pending) and enter a new sale. Super Admin can also edit a Pending or
--   Confirmed sale with update_sale, or void a Confirmed one.
-- * Discounts: per item and/or per receipt, either 'Percent' or 'Amount' (KHR).
-- * Rounding: unit price, each line total and the receipt total are rounded down
--   to the nearest 100 riel. Stored discount = the effective (rounded) discount.
-- * Adjustment: per receipt, adjustment_khr (+ extra / - short, multiple of 100) with a
--   required reason, for any variance between the calculated and actual total.
--   total = subtotal - discount + adjustment. Set when the sale is created.
-- * Anonymous sale = plate_no and customer left empty.
-- * sale_date is the Phnom Penh (UTC+7) calendar date; use it for daily reports.
--   Default = today. A past date needs the 'backdate_revenue' permission (Admin
--   grants it per role; Super Admin and Admin always have it); future dates are never allowed. A back-dated sale uses
--   the price and exchange rate that were in effect at the end of that day.
-- * sale_time is the Phnom Penh time of day (to the minute) of the sale. Default = now.
--   For today it cannot be later than now. It is only for display / sorting: prices and
--   the exchange rate are still looked up as described above.
-- * Live updates: sales and sale_items are added to the 'supabase_realtime' publication
--   (end of file), so the front-end gets INSERT/UPDATE events. Realtime respects the
--   select policy above. Views (report_*) cannot be subscribed to; refetch them on events.

-- ---------- Status enum ------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_type where typname = 'sale_status') then
    create type public.sale_status as enum ('Pending', 'Confirmed', 'Voided');
  end if;
end $$;

-- ---------- Helper functions -------------------------------------------
-- Controlled by Admin via role_permissions ('confirm_revenue'). See 01_users.sql.
create or replace function public.can_confirm_revenue()
returns boolean
language sql stable
as $$
  select public.has_permission('confirm_revenue');
$$;

-- Who can read sales: anyone who can enter revenue or view reports.
create or replace function public.can_view_sales()
returns boolean
language sql stable
as $$
  select public.has_permission('enter_revenue') or public.has_permission('view_report');
$$;

-- Round DOWN to the nearest 100 riel.
create or replace function public.round_down_khr(p_amount numeric)
returns bigint
language sql immutable
as $$
  select (floor(p_amount / 100) * 100)::bigint;
$$;

-- Effective discount in KHR (multiple of 100) for a base amount.
-- No discount: both type and value NULL. Percent must be 0-100; Amount cannot exceed base.
create or replace function public.calc_discount_khr(p_base bigint, p_type text, p_value numeric)
returns bigint
language plpgsql immutable
as $$
declare
  v_raw numeric;
begin
  if p_type is null and p_value is null then
    return 0;
  end if;

  if p_type is null or p_value is null or p_value < 0 then
    raise exception 'Invalid discount';
  end if;

  v_raw := case p_type
             when 'Percent' then p_base * p_value / 100
             when 'Amount'  then p_value
           end;

  if v_raw is null or v_raw > p_base then
    raise exception 'Invalid discount';
  end if;

  return p_base - public.round_down_khr(p_base - v_raw);
end $$;

-- =====================================================================
-- SALES (receipt header)
-- =====================================================================
-- created_by / confirmed_by / voided_by: NULL = Super Admin (displayed as "Admin").
create table if not exists public.sales (
  id                uuid primary key default gen_random_uuid(),
  receipt_no        bigint generated always as identity unique,
  sale_date         date not null,
  sale_time         time not null default date_trunc('minute', now() at time zone 'Asia/Phnom_Penh')::time,  -- Phnom Penh time of day
  status            public.sale_status not null default 'Pending',
  payment_method    text not null check (payment_method in ('Cash', 'Bank')),  -- Bank = KHQR / transfer
  plate_no          text,
  customer          text,                                                       -- customer name or ID
  subtotal_khr      bigint not null default 0,
  discount_type     text check (discount_type in ('Percent', 'Amount')),
  discount_value    numeric(12, 2),
  discount_reason   text,
  discount_khr      bigint not null default 0,
  adjustment_khr    bigint not null default 0,                                  -- + extra / - short
  adjustment_reason text,
  total_khr         bigint generated always as (subtotal_khr - discount_khr + adjustment_khr) stored,
  exchange_rate_id  uuid references public.exchange_rates (id),                 -- set only if a USD price was used
  usd_to_khr        numeric(12, 2),
  remark            text,
  confirmed_at      timestamptz,
  confirmed_by      uuid references public.users (id),
  voided_at         timestamptz,
  voided_by         uuid references public.users (id),
  void_reason       text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  created_by        uuid references public.users (id),
  updated_by        uuid references public.users (id),
  constraint sales_amounts_chk
    check (subtotal_khr >= 0 and subtotal_khr % 100 = 0
           and discount_khr >= 0 and discount_khr % 100 = 0
           and discount_khr <= subtotal_khr
           and adjustment_khr % 100 = 0
           and subtotal_khr - discount_khr + adjustment_khr >= 0),
  constraint sales_adjustment_chk
    check (adjustment_khr = 0 or length(trim(coalesce(adjustment_reason, ''))) > 0),
  constraint sales_discount_chk
    check ((discount_type is null) = (discount_value is null)),
  constraint sales_rate_chk
    check ((exchange_rate_id is null) = (usd_to_khr is null)),
  constraint sales_confirmed_chk
    check (status = 'Pending' and confirmed_at is null
           or status = 'Confirmed' and confirmed_at is not null
           or status = 'Voided'),
  constraint sales_voided_chk
    check ((status = 'Voided') = (voided_at is not null)
           and (status <> 'Voided' or length(trim(coalesce(void_reason, ''))) > 0))
);

-- For databases created with the older rule (Confirmed <=> confirmed_at set), so a
-- Confirmed sale voided by Super Admin keeps its confirmation record.
alter table public.sales drop constraint if exists sales_confirmed_chk;
alter table public.sales add constraint sales_confirmed_chk
  check (status = 'Pending' and confirmed_at is null
         or status = 'Confirmed' and confirmed_at is not null
         or status = 'Voided');

create index if not exists sales_sale_date_idx on public.sales (sale_date desc);
create index if not exists sales_status_idx on public.sales (status);

-- =====================================================================
-- SALE ITEMS (receipt lines)
-- =====================================================================
-- Exactly one target per line (same pattern as prices). A motorbike line stores
-- the size (required) and optionally the model. description is a snapshot so
-- receipts keep their original wording if catalog names change later.
create table if not exists public.sale_items (
  id                  uuid primary key default gen_random_uuid(),
  sale_id             uuid not null references public.sales (id),
  line_no             smallint not null,
  motorbike_size_id   smallint references public.motorbike_sizes (id),
  motorbike_model_id  uuid references public.motorbike_models (id),
  addon_service_id    uuid references public.addon_services (id),
  helmet_service_id   uuid references public.helmet_services (id),
  food_drink_item_id  uuid references public.food_drink_items (id),
  description         text not null,
  price_id            uuid not null references public.prices (id),
  unit_price_khr      bigint not null,
  quantity            smallint not null default 1 check (quantity > 0),
  gross_khr           bigint generated always as (unit_price_khr * quantity) stored,
  discount_type       text check (discount_type in ('Percent', 'Amount')),
  discount_value      numeric(12, 2),
  discount_reason     text,
  discount_khr        bigint not null default 0,
  total_khr           bigint generated always as (unit_price_khr * quantity - discount_khr) stored,
  remark              text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  created_by          uuid references public.users (id),
  updated_by          uuid references public.users (id),
  constraint sale_items_one_target_chk
    check (num_nonnulls(motorbike_size_id, addon_service_id,
                        helmet_service_id, food_drink_item_id) = 1),
  constraint sale_items_model_size_chk
    check (motorbike_model_id is null or motorbike_size_id is not null),
  constraint sale_items_discount_chk
    check ((discount_type is null) = (discount_value is null)),
  constraint sale_items_amounts_chk
    check (unit_price_khr >= 0 and unit_price_khr % 100 = 0
           and discount_khr >= 0 and discount_khr % 100 = 0
           and discount_khr <= unit_price_khr * quantity)
);

create unique index if not exists sale_items_sale_line_uq on public.sale_items (sale_id, line_no);

-- ---------- Triggers ---------------------------------------------------
drop trigger if exists trg_sales_audit on public.sales;
create trigger trg_sales_audit
  before insert or update on public.sales
  for each row execute function public.set_audit_columns();

drop trigger if exists trg_sale_items_audit on public.sale_items;
create trigger trg_sale_items_audit
  before insert or update on public.sale_items
  for each row execute function public.set_audit_columns();

-- Safety net: once a sale is Confirmed or Voided it can never change again.
-- Only exceptions (Super Admin): edit a Confirmed sale (stays Confirmed) or void it.
-- Voided stays final.
create or replace function public.sales_guard()
returns trigger
language plpgsql
as $$
begin
  if old.status <> 'Pending'
     and not (old.status = 'Confirmed' and new.status in ('Confirmed', 'Voided')
              and public.is_super_admin()) then
    raise exception 'Confirmed or voided sales cannot be changed';
  end if;
  return new;
end $$;

drop trigger if exists trg_sales_guard on public.sales;
create trigger trg_sales_guard
  before update on public.sales
  for each row execute function public.sales_guard();

-- ---------- Row Level Security -----------------------------------------
-- Read only for authorised users. All writes go through the functions below.
do $$
declare t text;
begin
  foreach t in array array['sales', 'sale_items'] loop
    execute format('alter table public.%I enable row level security', t);

    execute format('drop policy if exists %I on public.%I', t || '_select', t);
    execute format('create policy %I on public.%I for select to authenticated using (public.can_view_sales())',
                   t || '_select', t);

    execute format('drop policy if exists %I on public.%I', t || '_insert', t);
    execute format('drop policy if exists %I on public.%I', t || '_update', t);
    execute format('drop policy if exists %I on public.%I', t || '_delete', t);

    execute format('revoke all on public.%I from anon', t);
    execute format('revoke all on public.%I from authenticated', t);
    execute format('grant select on public.%I to authenticated', t);
  end loop;
end $$;

-- =====================================================================
-- Internal helpers shared by create_sale and update_sale (not callable by users)
-- =====================================================================

-- Validates the adjustment, sale date and sale time. Returns the final date/time and
-- the "price time" (now for today's sales, end of that day for back-dated ones).
create or replace function public.resolve_sale_header(
  p_sale_date  date,
  p_sale_time  time,
  p_adj        bigint,
  p_adj_reason text
)
returns table (h_date date, h_time time, h_at timestamptz)
language plpgsql stable
set search_path = public
as $$
declare
  v_today    date := (now() at time zone 'Asia/Phnom_Penh')::date;
  v_now_time time := date_trunc('minute', now() at time zone 'Asia/Phnom_Penh')::time;
begin
  if coalesce(p_adj, 0) % 100 <> 0 then
    raise exception 'Adjustment must be a multiple of 100 riel';
  end if;
  if coalesce(p_adj, 0) <> 0 and length(trim(coalesce(p_adj_reason, ''))) = 0 then
    raise exception 'An adjustment reason is required';
  end if;

  -- Sale date: today by default; past dates need 'backdate_revenue'; never future.
  h_date := coalesce(p_sale_date, v_today);
  if h_date > v_today then
    raise exception 'Sale date cannot be in the future';
  end if;
  if h_date < v_today and not public.has_permission('backdate_revenue') then
    raise exception 'You are not allowed to back-date sales';
  end if;

  -- Sale time: now by default (to the minute); today's sales cannot be in the future.
  h_time := case when p_sale_time is null then v_now_time
                 else make_time(extract(hour from p_sale_time)::int, extract(minute from p_sale_time)::int, 0) end;
  if h_date = v_today and h_time > v_now_time then
    raise exception 'Sale time cannot be in the future';
  end if;

  h_at := case when h_date = v_today then now()
               else ((h_date + 1)::timestamp at time zone 'Asia/Phnom_Penh') - interval '1 second' end;

  return next;
end $$;

-- Resolves ONE new receipt line: checks the product, builds the description snapshot,
-- finds the price in effect at p_at and converts it to KHR (rounded down to 100 riel).
-- p_usd_to_khr = exchange rate to use for USD prices (NULL if none exists).
create or replace function public.resolve_sale_line(
  p_item        jsonb,
  p_idx         int,
  p_at          timestamptz,
  p_usd_to_khr  numeric
)
returns table (
  size_id smallint, model_id uuid, addon_id uuid, helmet_id uuid, food_id uuid,
  line_desc text, price_id uuid, unit_khr bigint, qty int, used_usd boolean
)
language plpgsql stable
set search_path = public
as $$
#variable_conflict use_column
declare
  v_size   smallint := nullif(p_item ->> 'motorbike_size_id', '')::smallint;
  v_model  uuid     := nullif(p_item ->> 'motorbike_model_id', '')::uuid;
  v_addon  uuid     := nullif(p_item ->> 'addon_service_id', '')::uuid;
  v_helmet uuid     := nullif(p_item ->> 'helmet_service_id', '')::uuid;
  v_food   uuid     := nullif(p_item ->> 'food_drink_item_id', '')::uuid;
  v_qty    int      := coalesce(nullif(p_item ->> 'quantity', '')::int, 1);
  v_msize  smallint;
  v_desc   text;
  v_price  public.prices%rowtype;
begin
  if (v_size is not null or v_model is not null)::int
     + (v_addon is not null)::int + (v_helmet is not null)::int + (v_food is not null)::int <> 1 then
    raise exception 'Line %: choose exactly one product or service', p_idx;
  end if;
  if v_qty < 1 then
    raise exception 'Line %: quantity must be at least 1', p_idx;
  end if;

  -- Resolve the catalog item (must be active) and build the description snapshot.
  if v_model is not null then
    select m.size_id, 'Motorbike ' || s.code || ' - ' || m.brand || ' ' || m.model
      into v_msize, v_desc
      from public.motorbike_models m
      join public.motorbike_sizes s on s.id = m.size_id
     where m.id = v_model and m.is_active and s.is_active;
    if not found then
      raise exception 'Line %: motorbike model not found or inactive', p_idx;
    end if;
    if v_size is not null and v_size <> v_msize then
      raise exception 'Line %: motorbike model does not belong to the chosen size', p_idx;
    end if;
    v_size := v_msize;
  elsif v_size is not null then
    select 'Motorbike ' || code into v_desc
      from public.motorbike_sizes where id = v_size and is_active;
    if not found then
      raise exception 'Line %: motorbike size not found or inactive', p_idx;
    end if;
  elsif v_addon is not null then
    select description into v_desc
      from public.addon_services where id = v_addon and is_active;
    if not found then
      raise exception 'Line %: add-on service not found or inactive', p_idx;
    end if;
  elsif v_helmet is not null then
    select 'Helmet - ' || description into v_desc
      from public.helmet_services where id = v_helmet and is_active;
    if not found then
      raise exception 'Line %: helmet service not found or inactive', p_idx;
    end if;
  else
    select description into v_desc
      from public.food_drink_items where id = v_food and is_active;
    if not found then
      raise exception 'Line %: food/drink item not found or inactive', p_idx;
    end if;
  end if;

  -- Price in effect for this target at p_at.
  select p.* into v_price
  from public.prices p
  where p.effective_from <= p_at
    and case
          when v_size   is not null then p.motorbike_size_id  = v_size
          when v_addon  is not null then p.addon_service_id   = v_addon
          when v_helmet is not null then p.helmet_service_id  = v_helmet
          else p.food_drink_item_id = v_food
        end
  order by p.effective_from desc
  limit 1;

  if v_price.id is null then
    raise exception 'Line %: no price set for "%"', p_idx, v_desc;
  end if;

  used_usd := v_price.currency = 'USD';
  if used_usd then
    if p_usd_to_khr is null then
      raise exception 'No exchange rate set, cannot convert USD price for "%"', v_desc;
    end if;
    unit_khr := public.round_down_khr(v_price.amount * p_usd_to_khr);
  else
    unit_khr := public.round_down_khr(v_price.amount);
  end if;

  size_id := v_size;  model_id := v_model;  addon_id := v_addon;
  helmet_id := v_helmet;  food_id := v_food;
  line_desc := v_desc;  price_id := v_price.id;  qty := v_qty;

  return next;
end $$;

-- =====================================================================
-- create_sale
-- p_items = JSON array, one object per line. Per line, give exactly ONE of:
--   motorbike_size_id  and/or motorbike_model_id (model alone is enough; its size is used)
--   addon_service_id | helmet_service_id | food_drink_item_id
-- Optional per line: quantity (default 1), discount_type ('Percent'|'Amount'),
--   discount_value, discount_reason, remark.
-- Example:
--   [{"motorbike_model_id":"<uuid>","discount_type":"Percent","discount_value":10},
--    {"helmet_service_id":"<uuid>","quantity":2},
--    {"food_drink_item_id":"<uuid>"}]
-- Returns the new sale id (status = Pending).
-- =====================================================================
create or replace function public.create_sale(
  p_items            jsonb,
  p_payment_method   text,
  p_plate_no         text default null,
  p_customer         text default null,
  p_discount_type    text default null,
  p_discount_value   numeric default null,
  p_discount_reason  text default null,
  p_remark           text default null,
  p_sale_date        date default null,
  p_adjustment_khr   bigint default 0,
  p_adjustment_reason text default null,
  p_sale_time        time default null          -- Phnom Penh time of day; default = now
)
returns uuid
language plpgsql security definer
set search_path = public
as $$
declare
  v_sale_id    uuid := gen_random_uuid();
  v_adj        bigint := coalesce(p_adjustment_khr, 0);
  v_hdr        record;
  v_rate       public.exchange_rates%rowtype;
  v_used_rate  boolean := false;
  v_item       jsonb;
  v_idx        int;
  v_line       record;
  v_gross      bigint;
  v_dtype      text;
  v_dval       numeric;
  v_disc       bigint;
  v_subtotal   bigint := 0;
  v_sale_dtype text;
  v_sale_disc  bigint;
begin
  if not public.has_permission('enter_revenue') then
    raise exception 'You are not allowed to enter revenue';
  end if;

  if jsonb_typeof(p_items) is distinct from 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'A sale needs at least one item';
  end if;

  select * into v_hdr
  from public.resolve_sale_header(p_sale_date, p_sale_time, v_adj, p_adjustment_reason);

  -- Exchange rate in effect at that time (may be empty if no USD price is used).
  select * into v_rate
  from public.exchange_rates
  where effective_from <= v_hdr.h_at
  order by effective_from desc
  limit 1;

  insert into public.sales (id, sale_date, sale_time, payment_method, plate_no, customer, remark)
  values (v_sale_id,
          v_hdr.h_date,
          v_hdr.h_time,
          p_payment_method,
          nullif(upper(trim(p_plate_no)), ''),
          nullif(trim(p_customer), ''),
          nullif(trim(p_remark), ''));

  for v_item, v_idx in
    select value, ordinality from jsonb_array_elements(p_items) with ordinality
  loop
    select * into v_line
    from public.resolve_sale_line(v_item, v_idx, v_hdr.h_at, v_rate.usd_to_khr);

    v_used_rate := v_used_rate or v_line.used_usd;
    v_gross := v_line.unit_khr * v_line.qty;
    v_dtype := nullif(trim(v_item ->> 'discount_type'), '');
    v_dval  := nullif(v_item ->> 'discount_value', '')::numeric;
    v_disc  := public.calc_discount_khr(v_gross, v_dtype, v_dval);

    insert into public.sale_items (
      sale_id, line_no, motorbike_size_id, motorbike_model_id, addon_service_id,
      helmet_service_id, food_drink_item_id, description, price_id, unit_price_khr,
      quantity, discount_type, discount_value, discount_reason, discount_khr, remark
    ) values (
      v_sale_id, v_idx, v_line.size_id, v_line.model_id, v_line.addon_id,
      v_line.helmet_id, v_line.food_id, v_line.line_desc, v_line.price_id, v_line.unit_khr,
      v_line.qty, v_dtype, v_dval, nullif(trim(v_item ->> 'discount_reason'), ''), v_disc,
      nullif(trim(v_item ->> 'remark'), '')
    );

    v_subtotal := v_subtotal + v_gross - v_disc;
  end loop;

  -- Receipt-level discount, then save totals and the exchange rate used.
  v_sale_dtype := nullif(trim(p_discount_type), '');
  v_sale_disc  := public.calc_discount_khr(v_subtotal, v_sale_dtype, p_discount_value);

  if v_subtotal - v_sale_disc + v_adj < 0 then
    raise exception 'Adjustment cannot make the total negative';
  end if;

  update public.sales
     set subtotal_khr     = v_subtotal,
         discount_type    = v_sale_dtype,
         discount_value   = p_discount_value,
         discount_reason  = nullif(trim(p_discount_reason), ''),
         discount_khr     = v_sale_disc,
         adjustment_khr   = v_adj,
         adjustment_reason = nullif(trim(p_adjustment_reason), ''),
         exchange_rate_id = case when v_used_rate then v_rate.id end,
         usd_to_khr       = case when v_used_rate then v_rate.usd_to_khr end
   where id = v_sale_id;

  return v_sale_id;
end $$;

-- =====================================================================
-- update_sale  (Super Admin only; Pending or Confirmed sales, never Voided)
-- Replaces the receipt header and lines with what is sent (same fields as create_sale).
-- * p_items: a line WITH "id" (an existing sale_items id of this sale) is kept: it keeps
--   its product, price and unit price; only quantity, discount_type/value/reason and
--   remark are taken from the JSON (omitted = default). Product fields are ignored.
--   A line WITHOUT "id" is new and is priced at the sale date (end of that day if
--   back-dated). Existing lines not listed are deleted.
-- * If the sale already used an exchange rate, new USD lines use that same rate (one
--   rate per receipt); otherwise the rate in effect at the sale date.
-- * p_sale_date / p_sale_time omitted = keep the current ones. Future dates/times are
--   still refused. Status and confirmation record are unchanged.
-- * updated_at / updated_by record the edit ("Admin").
-- =====================================================================
create or replace function public.update_sale(
  p_sale_id          uuid,
  p_items            jsonb,
  p_payment_method   text,
  p_plate_no         text default null,
  p_customer         text default null,
  p_discount_type    text default null,
  p_discount_value   numeric default null,
  p_discount_reason  text default null,
  p_remark           text default null,
  p_sale_date        date default null,
  p_adjustment_khr   bigint default 0,
  p_adjustment_reason text default null,
  p_sale_time        time default null
)
returns void
language plpgsql security definer
set search_path = public
as $$
declare
  v_sale       public.sales%rowtype;
  v_adj        bigint := coalesce(p_adjustment_khr, 0);
  v_hdr        record;
  v_rate       public.exchange_rates%rowtype;
  v_keep       uuid[];
  v_item       jsonb;
  v_idx        int;
  v_item_id    uuid;
  v_line       record;
  v_unit       bigint;
  v_qty        int;
  v_gross      bigint;
  v_dtype      text;
  v_dval       numeric;
  v_disc       bigint;
  v_subtotal   bigint := 0;
  v_sale_dtype text;
  v_sale_disc  bigint;
  v_used_rate  boolean;
begin
  if not public.is_super_admin() then
    raise exception 'Only Super Admin can edit sales';
  end if;

  if jsonb_typeof(p_items) is distinct from 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'A sale needs at least one item';
  end if;

  select * into v_sale from public.sales where id = p_sale_id for update;
  if not found then
    raise exception 'Sale not found';
  end if;
  if v_sale.status = 'Voided' then
    raise exception 'Voided sales cannot be edited';
  end if;

  select * into v_hdr
  from public.resolve_sale_header(coalesce(p_sale_date, v_sale.sale_date),
                                  coalesce(p_sale_time, v_sale.sale_time),
                                  v_adj, p_adjustment_reason);

  -- Rate for new USD lines: the one already saved with the sale, else the rate at the sale date.
  if v_sale.exchange_rate_id is not null then
    select * into v_rate from public.exchange_rates where id = v_sale.exchange_rate_id;
  else
    select * into v_rate
    from public.exchange_rates
    where effective_from <= v_hdr.h_at
    order by effective_from desc
    limit 1;
  end if;

  -- Existing lines that stay.
  select coalesce(array_agg((value ->> 'id')::uuid), '{}'::uuid[]) into v_keep
  from jsonb_array_elements(p_items)
  where nullif(value ->> 'id', '') is not null;

  if (select count(distinct k) from unnest(v_keep) k) <> cardinality(v_keep) then
    raise exception 'The same item id is listed twice';
  end if;
  if exists (
    select 1 from unnest(v_keep) k
    where not exists (select 1 from public.sale_items where id = k and sale_id = p_sale_id)
  ) then
    raise exception 'An item id does not belong to this sale';
  end if;

  delete from public.sale_items where sale_id = p_sale_id and id <> all (v_keep);
  -- Free the line numbers so lines can be renumbered without clashing.
  update public.sale_items set line_no = -line_no where sale_id = p_sale_id;

  for v_item, v_idx in
    select value, ordinality from jsonb_array_elements(p_items) with ordinality
  loop
    v_item_id := nullif(v_item ->> 'id', '')::uuid;

    if v_item_id is not null then
      v_qty := coalesce(nullif(v_item ->> 'quantity', '')::int, 1);
      if v_qty < 1 then
        raise exception 'Line %: quantity must be at least 1', v_idx;
      end if;
      select unit_price_khr into v_unit from public.sale_items where id = v_item_id;
    else
      select * into v_line
      from public.resolve_sale_line(v_item, v_idx, v_hdr.h_at, v_rate.usd_to_khr);
      v_unit := v_line.unit_khr;
      v_qty  := v_line.qty;
    end if;

    v_gross := v_unit * v_qty;
    v_dtype := nullif(trim(v_item ->> 'discount_type'), '');
    v_dval  := nullif(v_item ->> 'discount_value', '')::numeric;
    v_disc  := public.calc_discount_khr(v_gross, v_dtype, v_dval);

    if v_item_id is not null then
      update public.sale_items
         set line_no         = v_idx,
             quantity        = v_qty,
             discount_type   = v_dtype,
             discount_value  = v_dval,
             discount_reason = nullif(trim(v_item ->> 'discount_reason'), ''),
             discount_khr    = v_disc,
             remark          = nullif(trim(v_item ->> 'remark'), '')
       where id = v_item_id;
    else
      insert into public.sale_items (
        sale_id, line_no, motorbike_size_id, motorbike_model_id, addon_service_id,
        helmet_service_id, food_drink_item_id, description, price_id, unit_price_khr,
        quantity, discount_type, discount_value, discount_reason, discount_khr, remark
      ) values (
        p_sale_id, v_idx, v_line.size_id, v_line.model_id, v_line.addon_id,
        v_line.helmet_id, v_line.food_id, v_line.line_desc, v_line.price_id, v_line.unit_khr,
        v_qty, v_dtype, v_dval, nullif(trim(v_item ->> 'discount_reason'), ''), v_disc,
        nullif(trim(v_item ->> 'remark'), '')
      );
    end if;

    v_subtotal := v_subtotal + v_gross - v_disc;
  end loop;

  v_sale_dtype := nullif(trim(p_discount_type), '');
  v_sale_disc  := public.calc_discount_khr(v_subtotal, v_sale_dtype, p_discount_value);

  if v_subtotal - v_sale_disc + v_adj < 0 then
    raise exception 'Adjustment cannot make the total negative';
  end if;

  -- The saved rate is kept only while at least one line is priced in USD.
  select exists (
    select 1
    from public.sale_items si
    join public.prices p on p.id = si.price_id
    where si.sale_id = p_sale_id and p.currency = 'USD'
  ) into v_used_rate;

  update public.sales
     set sale_date         = v_hdr.h_date,
         sale_time         = v_hdr.h_time,
         payment_method    = p_payment_method,
         plate_no          = nullif(upper(trim(p_plate_no)), ''),
         customer          = nullif(trim(p_customer), ''),
         remark            = nullif(trim(p_remark), ''),
         subtotal_khr      = v_subtotal,
         discount_type     = v_sale_dtype,
         discount_value    = p_discount_value,
         discount_reason   = nullif(trim(p_discount_reason), ''),
         discount_khr      = v_sale_disc,
         adjustment_khr    = v_adj,
         adjustment_reason = nullif(trim(p_adjustment_reason), ''),
         exchange_rate_id  = case when v_used_rate then v_rate.id end,
         usd_to_khr        = case when v_used_rate then v_rate.usd_to_khr end
   where id = p_sale_id;
end $$;

-- =====================================================================
-- confirm_sale  (needs 'confirm_revenue' permission)
-- =====================================================================
create or replace function public.confirm_sale(p_sale_id uuid)
returns void
language plpgsql security definer
set search_path = public
as $$
declare
  actor uuid := case when public.is_super_admin() then null else auth.uid() end;
begin
  if not public.can_confirm_revenue() then
    raise exception 'You are not allowed to confirm sales';
  end if;

  update public.sales
     set status = 'Confirmed', confirmed_at = now(), confirmed_by = actor
   where id = p_sale_id and status = 'Pending';

  if not found then
    raise exception 'Sale not found or not Pending';
  end if;
end $$;

-- =====================================================================
-- void_sale  (reason required)
-- Users with 'confirm_revenue' can void any Pending sale.
-- Other users can void only the Pending sales they entered themselves.
-- Super Admin can also void Confirmed sales.
-- =====================================================================
create or replace function public.void_sale(p_sale_id uuid, p_reason text)
returns void
language plpgsql security definer
set search_path = public
as $$
declare
  actor     uuid := case when public.is_super_admin() then null else auth.uid() end;
  v_status  public.sale_status;
  v_creator uuid;
begin
  if length(trim(coalesce(p_reason, ''))) = 0 then
    raise exception 'A void reason is required';
  end if;

  select status, created_by into v_status, v_creator
  from public.sales where id = p_sale_id for update;

  if not found then
    raise exception 'Sale not found';
  end if;
  if v_status = 'Voided'
     or (v_status = 'Confirmed' and not public.is_super_admin()) then
    raise exception 'Only Pending sales can be voided';
  end if;
  if not (public.can_confirm_revenue()
          or (public.has_permission('enter_revenue') and v_creator is not distinct from actor)) then
    raise exception 'You are not allowed to void this sale';
  end if;

  update public.sales
     set status = 'Voided', voided_at = now(), voided_by = actor, void_reason = trim(p_reason)
   where id = p_sale_id;
end $$;

-- ---------- Function access ---------------------------------------------
revoke execute on function public.create_sale(jsonb, text, text, text, text, numeric, text, text, date, bigint, text, time) from public, anon;
revoke execute on function public.update_sale(uuid, jsonb, text, text, text, text, numeric, text, text, date, bigint, text, time) from public, anon;
revoke execute on function public.resolve_sale_header(date, time, bigint, text) from public, anon, authenticated;
revoke execute on function public.resolve_sale_line(jsonb, int, timestamptz, numeric) from public, anon, authenticated;
revoke execute on function public.confirm_sale(uuid) from public, anon;
revoke execute on function public.void_sale(uuid, text) from public, anon;

grant execute on function public.create_sale(jsonb, text, text, text, text, numeric, text, text, date, bigint, text, time) to authenticated;
grant execute on function public.update_sale(uuid, jsonb, text, text, text, text, numeric, text, text, date, bigint, text, time) to authenticated;
grant execute on function public.confirm_sale(uuid) to authenticated;
grant execute on function public.void_sale(uuid, text) to authenticated;

-- ---------- Realtime (live updates to the front-end) -------------------
do $$
declare t text;
begin
  foreach t in array array['sales', 'sale_items'] loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public'
        and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;
