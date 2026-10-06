-- =====================================================================
-- 08_reports.sql  |  Revenue report views
-- Requires 01_users.sql through 07_sales.sql. Safe to re-run.
-- =====================================================================
-- * Only users with the 'view_report' permission get any rows (Admin and
--   Super Admin always do). Everyone else sees empty results.
-- * Voided sales are excluded (listed separately in report_voided_sales).
-- * Pending and Confirmed sales are both included; filter on `status`
--   (e.g. status = 'Confirmed') in the front-end when only confirmed is needed.
-- * All amounts are KHR. Filter by date with sale_date (Phnom Penh date), e.g.
--     .gte('sale_date', '2026-10-01').lte('sale_date', '2026-10-31')
--
-- Definitions:  gross = before any discount
--               discount = item discounts + receipt discount
--               adjustment = per-receipt variance (+ extra / - short) with a reason
--               net = revenue (gross - discount + adjustment) = sales.total_khr
-- Adjustments are receipt-level only: they appear in report_sales, report_daily and
-- report_monthly. Category and item reports show sales value before adjustments, so
-- their totals differ from daily net by the adjustment amount.
--
-- Views:
--   report_sales          one row per receipt            (base)
--   report_lines          one row per receipt line       (base, receipt discount spread across lines)
--   report_daily          date x status x payment method
--   report_monthly        month x status x payment method
--   report_by_category    date x status x category x sub-category
--                         (category: Motorbike, Add-on, Helmet, Food, Drink;
--                          sub-category: motorbike size, or food/drink category)
--   report_by_item        date x status x category x item description
--   report_voided_sales   voided receipts with who/why

-- ---------- Base: receipts ---------------------------------------------
create or replace view public.report_sales
with (security_invoker = true) as
select s.id                              as sale_id,
       s.receipt_no,
       s.sale_date,
       s.status,
       s.payment_method,
       s.plate_no,
       s.customer,
       i.items_count,
       i.quantity,
       i.gross_khr,
       i.item_discount_khr,
       s.discount_khr                    as receipt_discount_khr,
       i.item_discount_khr + s.discount_khr as discount_khr,
       s.adjustment_khr,
       s.adjustment_reason,
       s.total_khr                       as net_khr
from public.sales s
cross join lateral (
  select count(*)::int                  as items_count,
         sum(quantity)::int             as quantity,
         sum(gross_khr)::bigint         as gross_khr,
         sum(discount_khr)::bigint      as item_discount_khr
  from public.sale_items
  where sale_id = s.id
) i
where s.status <> 'Voided'
  and (select public.has_permission('view_report'));

-- ---------- Base: receipt lines ----------------------------------------
-- The receipt-level discount is spread across the lines in proportion to each
-- line's amount (rounded down to 100 riel; the remainder goes to the last line),
-- so line nets always add up exactly to the receipt net.
create or replace view public.report_lines
with (security_invoker = true) as
with base as (
  select s.id                       as sale_id,
         s.receipt_no,
         s.sale_date,
         s.status,
         s.payment_method,
         i.id                       as item_id,
         i.line_no,
         i.description,
         i.quantity,
         case when i.motorbike_size_id is not null then 'Motorbike'
              when i.addon_service_id  is not null then 'Add-on'
              when i.helmet_service_id is not null then 'Helmet'
              else fc.kind
         end                        as category,
         coalesce(ms.code, fc.name) as sub_category,
         i.gross_khr,
         i.discount_khr             as item_discount_khr,
         i.total_khr                as line_total_khr,
         s.discount_khr             as receipt_discount_khr,
         case when s.subtotal_khr = 0 then 0
              else public.round_down_khr(s.discount_khr::numeric * i.total_khr / s.subtotal_khr)
         end                        as alloc_floor,
         max(i.line_no) over (partition by i.sale_id) as last_line_no
  from public.sales s
  join public.sale_items i on i.sale_id = s.id
  left join public.motorbike_sizes ms on ms.id = i.motorbike_size_id
  left join public.food_drink_items fi on fi.id = i.food_drink_item_id
  left join public.food_drink_categories fc on fc.id = fi.category_id
  where s.status <> 'Voided'
    and (select public.has_permission('view_report'))
),
alloc as (
  select base.*,
         alloc_floor
         + case when line_no = last_line_no
                then receipt_discount_khr - sum(alloc_floor) over (partition by sale_id)
                else 0 end::bigint as receipt_discount_alloc_khr
  from base
)
select sale_id, receipt_no, sale_date, status, payment_method,
       item_id, line_no, category, sub_category, description, quantity,
       gross_khr,
       item_discount_khr,
       receipt_discount_alloc_khr,
       item_discount_khr + receipt_discount_alloc_khr as discount_khr,
       line_total_khr - receipt_discount_alloc_khr    as net_khr
from alloc;

-- ---------- Daily / monthly --------------------------------------------
create or replace view public.report_daily
with (security_invoker = true) as
select sale_date,
       status,
       payment_method,
       count(*)::int                as receipts,
       sum(gross_khr)::bigint       as gross_khr,
       sum(discount_khr)::bigint    as discount_khr,
       sum(adjustment_khr)::bigint  as adjustment_khr,
       sum(net_khr)::bigint         as net_khr
from public.report_sales
group by sale_date, status, payment_method;

create or replace view public.report_monthly
with (security_invoker = true) as
select date_trunc('month', sale_date::timestamp)::date as month,
       status,
       payment_method,
       sum(receipts)::int           as receipts,
       sum(gross_khr)::bigint       as gross_khr,
       sum(discount_khr)::bigint    as discount_khr,
       sum(adjustment_khr)::bigint  as adjustment_khr,
       sum(net_khr)::bigint         as net_khr
from public.report_daily
group by 1, status, payment_method;

-- ---------- By category / by item --------------------------------------
create or replace view public.report_by_category
with (security_invoker = true) as
select sale_date,
       status,
       category,
       sub_category,
       sum(quantity)::int           as quantity,
       sum(gross_khr)::bigint       as gross_khr,
       sum(discount_khr)::bigint    as discount_khr,
       sum(net_khr)::bigint         as net_khr
from public.report_lines
group by sale_date, status, category, sub_category;

create or replace view public.report_by_item
with (security_invoker = true) as
select sale_date,
       status,
       category,
       description,
       sum(quantity)::int           as quantity,
       sum(gross_khr)::bigint       as gross_khr,
       sum(discount_khr)::bigint    as discount_khr,
       sum(net_khr)::bigint         as net_khr
from public.report_lines
group by sale_date, status, category, description;

-- ---------- Voided sales (audit) ---------------------------------------
create or replace view public.report_voided_sales
with (security_invoker = true) as
select s.id                          as sale_id,
       s.receipt_no,
       s.sale_date,
       s.payment_method,
       s.total_khr,
       s.void_reason,
       s.voided_at,
       public.actor_name(s.voided_by) as voided_by_name,
       s.created_at,
       public.actor_name(s.created_by) as entered_by_name
from public.sales s
where s.status = 'Voided'
  and (select public.has_permission('view_report'));

-- ---------- Access ------------------------------------------------------
revoke all on public.report_sales, public.report_lines, public.report_daily,
              public.report_monthly, public.report_by_category,
              public.report_by_item, public.report_voided_sales from anon;
grant select on public.report_sales, public.report_lines, public.report_daily,
                public.report_monthly, public.report_by_category,
                public.report_by_item, public.report_voided_sales to authenticated;
