-- =====================================================================
-- 09_charts.sql  |  Data views for dashboard charts
-- Requires 01_users.sql through 08_reports.sql. Safe to re-run.
-- =====================================================================
-- * Same access rule as the report views: only users with the 'view_report'
--   permission get rows (Admin and Super Admin always do).
-- * Voided sales are excluded. Pending and Confirmed are both included;
--   filter on `status` in the front-end if needed.
-- * Add future chart views to this file.
--
-- Views:
--   chart_hourly   sale date x hour of day (0-23, from sales.sale_time) x status
--                  receipts = number of receipts, net_khr = sales.total_khr
--                  Average receipt for any date range = sum(net_khr) / sum(receipts)

create or replace view public.chart_hourly
with (security_invoker = true) as
select s.sale_date,
       substr(s.sale_time::text, 1, 2)::int as hour,
       s.status,
       count(*)::int                        as receipts,
       sum(s.total_khr)::bigint             as net_khr
from public.sales s
where s.status <> 'Voided'
  and (select public.has_permission('view_report'))
group by s.sale_date, substr(s.sale_time::text, 1, 2)::int, s.status;

-- ---------- Access ------------------------------------------------------
revoke all on public.chart_hourly from anon;
grant select on public.chart_hourly to authenticated;
