// assets/js/home.js
// Home page: greeting, quick actions, last-30-days totals, charts, and today's latest sales.
// Reads: sales (30-day totals), sales + sale_items (latest today),
//        report_daily / report_monthly, report_by_category (08_reports.sql).
// Cards + latest sales: users who can enter revenue or view reports. Charts: users who can view reports.
// All charts share the Day / Month range of the Revenue trend chart.
// Clicking a latest-sales row opens the receipt details (read-only) with the shared SaleForm (sale-form.js).
// Load AFTER sidebar.js (it fires `app:ready`), sale-form.js and Chart.js.
(() => {
  const { $, esc, toast, badge, fetchAll, TZ, fmt, todayStr } = UI;
  const RECENT = 8;          // latest sales shown
  const TREND_DAYS = 30;     // points in "Day" view
  const TREND_MONTHS = 12;   // points in "Month" view
  const STATS_SELECT = 'status, payment_method, total_khr';
  const SELECT = 'id, receipt_no, status, payment_method, total_khr, sale_time, sale_items(line_no, description, quantity)';

  const hhmm = (t) => (t || '').slice(0, 5);
  const sum = (rows, key = 'total_khr') => rows.reduce((s, r) => s + Number(r[key]), 0);

  // Cards range: last 30 days up to and including the shop's "today" (same window as the chart's Day view)
  function statsRange() {
    const keys = trendKeys('day');
    return { start: keys[0], end: keys[keys.length - 1], label: `Last ${TREND_DAYS} days` };
  }

  function greeting() {
    const h = Number(new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: 'numeric', hourCycle: 'h23' }).format(new Date()));
    return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
  }

  function renderStats(rows, label) {
    const live = rows.filter((r) => r.status !== 'Voided');
    const pending = rows.filter((r) => r.status === 'Pending');
    const by = (m) => sum(live.filter((r) => r.payment_method === m));

    $('statNet').textContent = fmt(sum(live));
    $('statNetSub').textContent = `${live.length} receipt${live.length === 1 ? '' : 's'} · ${label}`;
    $('statCash').textContent = fmt(by('Cash'));
    $('statCashSub').textContent = label;
    $('statBank').textContent = fmt(by('Bank'));
    $('statBankSub').textContent = label;
    $('statPending').textContent = String(pending.length);
    $('statPendingSub').textContent = pending.length ? fmt(sum(pending)) : 'All confirmed';
  }

  function renderRecent(rows) {
    $('recentBody').innerHTML = rows.length
      ? rows.map((r) => {
        const items = [...(r.sale_items || [])]
          .sort((a, b) => a.line_no - b.line_no)
          .map((i) => `${esc(i.description)} ×${i.quantity}`)
          .join(', ');
        return `<tr class="row-click${r.status === 'Voided' ? ' row-voided' : ''}" data-id="${r.id}" tabindex="0" title="View details">
          <td>#${r.receipt_no}<br><span class="small">${hhmm(r.sale_time)} · ${esc(r.payment_method)}</span></td>
          <td>${items}</td>
          <td class="num">${fmt(r.total_khr)}</td>
          <td>${badge(r.status)}</td>
        </tr>`;
      }).join('')
      : '<tr><td colspan="4" class="empty">No sales yet today.</td></tr>';
  }

  // ---------- Charts ----------
  const TREND = {
    day:   { view: 'report_daily',   col: 'sale_date', sub: `Last ${TREND_DAYS} days`,     fmtOpt: { day: 'numeric', month: 'short' } },
    month: { view: 'report_monthly', col: 'month',     sub: `Last ${TREND_MONTHS} months`, fmtOpt: { month: 'short', year: '2-digit' } },
  };
  const compact = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });
  const PIE_COLORS = ['#0d6efd', '#198754', '#fd7e14', '#6f42c1', '#dc3545', '#20c997', '#6c757d'];
  const charts = {};
  let weekdayReceipts = [];   // total receipts per weekday (for the weekday tooltip)
  let trendMode = 'day';
  let trendOn = false;
  let chartSeq = 0;

  // Ordered x-axis keys (YYYY-MM-DD) ending at the shop's "today"; month keys are first-of-month.
  function trendKeys(mode) {
    const [y, m, d] = todayStr().split('-').map(Number);
    const keys = [];
    for (let i = (mode === 'day' ? TREND_DAYS : TREND_MONTHS) - 1; i >= 0; i--) {
      const dt = mode === 'day' ? new Date(Date.UTC(y, m - 1, d - i)) : new Date(Date.UTC(y, m - 1 - i, 1));
      keys.push(dt.toISOString().slice(0, 10));
    }
    return keys;
  }

  const primaryColor = () => {
    const css = getComputedStyle(document.documentElement).getPropertyValue('--bs-primary').trim();
    return /^#[0-9a-f]{6}$/i.test(css) ? css : '#0d6efd';
  };

  // --- chart configs (one per chart type) ---
  const axisY = { beginAtZero: true, ticks: { precision: 0, callback: (v) => compact.format(v) } };

  const lineConfig = (labels, data, { name, color, tip }) => ({
    type: 'line',
    data: { labels, datasets: [{ label: name, data, borderColor: color, backgroundColor: `${color}22`, fill: true, tension: 0.3, pointRadius: 3 }] },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => tip(c.parsed.y) } } },
      scales: { y: axisY, x: { ticks: { autoSkip: true, maxTicksLimit: 10 } } },
    },
  });

  const pieConfig = (labels, data) => ({
    type: 'pie',
    data: { labels, datasets: [{ data, backgroundColor: labels.map((_, i) => PIE_COLORS[i % PIE_COLORS.length]) }] },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { position: 'bottom' },
        tooltip: {
          callbacks: {
            label: (c) => {
              const total = c.dataset.data.reduce((s, v) => s + v, 0);
              return `${c.label}: ${fmt(c.parsed)} (${total ? Math.round((c.parsed / total) * 100) : 0}%)`;
            },
          },
        },
      },
    },
  });

  const barConfig = (labels, data, color) => ({
    type: 'bar',
    data: { labels, datasets: [{ label: 'Avg receipts per day', data, backgroundColor: color, borderRadius: 3 }] },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (c) => `${c.parsed.y} receipts per day`,
            afterLabel: (c) => `${weekdayReceipts[c.dataIndex] || 0} receipts in total`,
          },
        },
      },
      scales: { y: { beginAtZero: true } },
    },
  });

  // Create the chart on first use, then just swap its data.
  function draw(key, canvasId, cfg) {
    if (typeof Chart === 'undefined') { toast('Chart library could not be loaded.'); return; }
    if (charts[key]) { charts[key].data = cfg.data; charts[key].update(); return; }
    charts[key] = new Chart($(canvasId), cfg);
  }

  // --- data -> chart ---
  function drawTrend(rows, keys, cfg) {
    const totals = Object.fromEntries(keys.map((k) => [k, { net: 0, receipts: 0 }]));
    rows.forEach((r) => {
      const t = totals[r[cfg.col]];
      if (t) { t.net += Number(r.net_khr); t.receipts += Number(r.receipts); }
    });
    const labels = keys.map((k) => new Date(`${k}T00:00:00Z`).toLocaleDateString('en-GB', { timeZone: 'UTC', ...cfg.fmtOpt }));
    draw('revenue', 'trendCanvas', lineConfig(labels, keys.map((k) => totals[k].net), { name: 'Net revenue', color: primaryColor(), tip: fmt }));
    draw('receipts', 'receiptsCanvas', lineConfig(labels, keys.map((k) => totals[k].receipts), { name: 'Receipts', color: '#198754', tip: (v) => `${v} receipt(s)` }));
  }

  function drawCategory(rows) {
    const by = new Map();
    rows.forEach((r) => { const k = r.category || 'Other'; by.set(k, (by.get(k) || 0) + Number(r.net_khr)); });
    const items = [...by].filter(([, v]) => v !== 0).sort((a, b) => b[1] - a[1]);
    draw('category', 'categoryCanvas', pieConfig(items.map(([k]) => k), items.map(([, v]) => v)));
  }

  // Average receipts per trading day for each weekday, Mon..Sun (rows = report_daily: sale_date, receipts)
  function drawWeekday(rows) {
    const perDate = new Map();   // sale_date -> receipts that day (all statuses / payment methods)
    rows.forEach((r) => perDate.set(r.sale_date, (perDate.get(r.sale_date) || 0) + Number(r.receipts)));
    const total = Array(7).fill(0);   // receipts per weekday
    const days = Array(7).fill(0);    // trading days per weekday (days with at least one sale)
    perDate.forEach((n, date) => {
      const i = (new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7;   // Mon = 0 .. Sun = 6
      total[i] += n;
      days[i] += 1;
    });
    weekdayReceipts = total;
    const avg = total.map((n, i) => (days[i] ? Math.round((n / days[i]) * 10) / 10 : 0));
    draw('weekday', 'weekdayCanvas', barConfig(['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'], avg, primaryColor()));
  }

  async function loadCharts() {
    if (!trendOn) return;
    const my = ++chartSeq;
    const cfg = TREND[trendMode];
    const keys = trendKeys(trendMode);
    const start = keys[0];
    const end = todayStr();
    $('trendSub').textContent = cfg.sub;

    const [trend, cat, week] = await Promise.allSettled([
      fetchAll(() => sb.from(cfg.view).select(`${cfg.col}, receipts, net_khr`)
        .gte(cfg.col, start).lte(cfg.col, keys[keys.length - 1]).order(cfg.col)),
      fetchAll(() => sb.from('report_by_category').select('category, net_khr')
        .gte('sale_date', start).lte('sale_date', end)
        .order('sale_date').order('status').order('category').order('sub_category')),
      fetchAll(() => sb.from('report_daily').select('sale_date, receipts')
        .gte('sale_date', start).lte('sale_date', end)
        .order('sale_date').order('status').order('payment_method')),
    ]);
    if (my !== chartSeq) return;

    const failed = [trend, cat, week].find((r) => r.status === 'rejected');
    if (failed) toast(`Could not load charts: ${failed.reason.message}`);
    if (trend.status === 'fulfilled') drawTrend(trend.value, keys, cfg);
    if (cat.status === 'fulfilled') drawCategory(cat.value);
    if (week.status === 'fulfilled') drawWeekday(week.value);
  }

  // ---------- Page load ----------
  let loadSeq = 0;
  async function load() {
    const my = ++loadSeq;
    const { start, end, label } = statsRange();
    loadCharts();
    let statRows, todayRows;
    try {
      [statRows, todayRows] = await Promise.all([
        fetchAll(() => sb.from('sales').select(STATS_SELECT)
          .gte('sale_date', start)
          .lte('sale_date', end)),
        sb.from('sales').select(SELECT)
          .eq('sale_date', todayStr())
          .order('sale_time', { ascending: false })
          .order('receipt_no', { ascending: false })
          .limit(RECENT)
          .then(({ data, error }) => { if (error) throw error; return data; }),
      ]);
    } catch (err) {
      if (my === loadSeq) toast(`Could not load sales: ${err.message}`);
      return;
    }
    if (my !== loadSeq) return;
    renderStats(statRows, label);
    renderRecent(todayRows);
  }

  function init(detail) {
    const { name, perms } = detail;
    const can = (key) => perms.includes(key);

    $('greeting').textContent = `${greeting()}, ${name.trim().split(/\s+/)[0]}`;
    $('todayLabel').textContent = new Date(`${todayStr()}T00:00:00`)
      .toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

    // Quick actions: only what this user may open.
    const actions = [];
    if (can('enter_revenue')) actions.push('<a class="btn btn-primary" href="sales.html">+ New sale</a>');
    if (can('view_report')) actions.push('<a class="btn btn-outline-secondary" href="reports.html">View reports</a>');
    $('quickActions').innerHTML = actions.join('');

    if (!can('enter_revenue') && !can('view_report')) return;   // nothing to show for sales
    $('todayBlock').classList.remove('hidden');

    // Charts read the report views, which return rows only with 'view_report'.
    if (can('view_report')) {
      trendOn = true;
      $('trendCard').classList.remove('hidden');
      $('chartRow').classList.remove('hidden');
      document.querySelectorAll('input[name="trendMode"]').forEach((r) => r.addEventListener('change', (e) => {
        trendMode = e.target.value;
        loadCharts();
      }));
    }

    SaleForm.init(detail, { onSaved: load });
    const openRow = (el) => { const tr = el.closest('tr[data-id]'); if (tr) SaleForm.open(tr.dataset.id, { view: true }); };
    $('recentBody').addEventListener('click', (e) => openRow(e.target));
    $('recentBody').addEventListener('keydown', (e) => { if (e.key === 'Enter') openRow(e.target); });
    load();
    RealtimeSync.watch({ name: 'home', tables: ['sales', 'sale_items'], onChange: load });
  }

  window.addEventListener('app:ready', (e) => init(e.detail), { once: true });
})();
