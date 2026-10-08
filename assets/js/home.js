// assets/js/home.js
// Home page: greeting, quick actions, last-30-days totals, revenue trend chart, and today's latest sales.
// Reads: sales (30-day totals), sales + sale_items (latest today), report_daily / report_monthly (trend chart).
// Cards + latest sales: users who can enter revenue or view reports. Trend chart: users who can view reports.
// Clicking a latest-sales row opens the receipt details (read-only) with the shared SaleForm (sale-form.js).
// Load AFTER sidebar.js (it fires `app:ready`), sale-form.js and Chart.js.
(() => {
  const { $, esc, toast, badge, fetchAll, TZ, fmt, todayStr } = UI;
  const RECENT = 8;   // latest sales shown
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

  // ---------- Revenue trend chart (report_daily / report_monthly) ----------
  const TREND = {
    day:   { view: 'report_daily',   col: 'sale_date', sub: `Last ${TREND_DAYS} days`,     fmtOpt: { day: 'numeric', month: 'short' } },
    month: { view: 'report_monthly', col: 'month',     sub: `Last ${TREND_MONTHS} months`, fmtOpt: { month: 'short', year: '2-digit' } },
  };
  const compact = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });
  let trendChart = null;
  let trendMode = 'day';
  let trendOn = false;
  let trendSeq = 0;

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

  function drawTrend(labels, values) {
    if (typeof Chart === 'undefined') { toast('Chart library could not be loaded.'); return; }
    if (trendChart) {
      trendChart.data.labels = labels;
      trendChart.data.datasets[0].data = values;
      trendChart.update();
      return;
    }
    const css = getComputedStyle(document.documentElement).getPropertyValue('--bs-primary').trim();
    const color = /^#[0-9a-f]{6}$/i.test(css) ? css : '#0d6efd';
    trendChart = new Chart($('trendCanvas'), {
      type: 'line',
      data: {
        labels,
        datasets: [{
          label: 'Net revenue',
          data: values,
          borderColor: color,
          backgroundColor: `${color}22`,
          fill: true,
          tension: 0.3,
          pointRadius: 3,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: { label: (c) => fmt(c.parsed.y) } },
        },
        scales: {
          y: { beginAtZero: true, ticks: { callback: (v) => compact.format(v) } },
          x: { ticks: { autoSkip: true, maxTicksLimit: 10 } },
        },
      },
    });
  }

  async function loadTrend() {
    if (!trendOn) return;
    const my = ++trendSeq;
    const cfg = TREND[trendMode];
    const keys = trendKeys(trendMode);
    let rows;
    try {
      rows = await fetchAll(() => sb.from(cfg.view).select(`${cfg.col}, net_khr`)
        .gte(cfg.col, keys[0])
        .lte(cfg.col, keys[keys.length - 1])
        .order(cfg.col));
    } catch (err) {
      if (my === trendSeq) toast(`Could not load revenue trend: ${err.message}`);
      return;
    }
    if (my !== trendSeq) return;

    const totals = Object.fromEntries(keys.map((k) => [k, 0]));
    rows.forEach((r) => { if (r[cfg.col] in totals) totals[r[cfg.col]] += Number(r.net_khr); });
    const labels = keys.map((k) => new Date(`${k}T00:00:00Z`).toLocaleDateString('en-GB', { timeZone: 'UTC', ...cfg.fmtOpt }));
    $('trendSub').textContent = cfg.sub;
    drawTrend(labels, keys.map((k) => totals[k]));
  }

  // ---------- Page load ----------
  let loadSeq = 0;
  async function load() {
    const my = ++loadSeq;
    const { start, end, label } = statsRange();
    loadTrend();
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

    // Trend chart reads the report views, which return rows only with 'view_report'.
    if (can('view_report')) {
      trendOn = true;
      $('trendCard').classList.remove('hidden');
      document.querySelectorAll('input[name="trendMode"]').forEach((r) => r.addEventListener('change', (e) => {
        trendMode = e.target.value;
        loadTrend();
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
