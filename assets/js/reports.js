// assets/js/reports.js
// Reports page: filters, summary cards and four views (Daily, By category, By item, Voided).
// Reads only the report_* views from 08_reports.sql (they return rows only for users with 'view_report').
// Load AFTER sidebar.js (it fires `app:ready`).
(() => {
  const CAT_ORDER = ['Motorbike', 'Add-on', 'Helmet', 'Food', 'Drink'];

  const { $, esc, toast, fetchAll, TZ, fmt, signed, todayStr, dayLabel, shiftDay } = UI;
  const dayLabelLong = (d) => new Date(`${d}T00:00:00`).toLocaleDateString('en-GB', { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' });
  const monthLabel = (m) => new Date(`${m}-01T00:00:00`).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
  const dateTime = (iso) => new Date(iso).toLocaleString('en-GB', { timeZone: TZ, day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
  const utcDay = (y, m, d) => new Date(Date.UTC(y, m, d)).toISOString().slice(0, 10);

  let me;
  const monthStart = (t = todayStr()) => `${t.slice(0, 8)}01`;
  const defaultFilters = () => ({ from: monthStart(), to: todayStr(), status: '', payment: '' });
  let f = defaultFilters();
  let active = 'daily';
  let cache = {};   // tab -> rows for the current filters
  let gen = 0;      // bumped whenever cached data becomes stale

  // Column filters (multi-select in the table headers).
  // colSel['<tab>.<field>'] = Set of ticked values; missing / null = no filter (all values).
  const colSel = {};
  const FIELD = {
    category: (r) => r.category ?? '',
    sub: (r) => r.sub_category ?? '',
    item: (r) => r.description ?? ''
  };
  const catRank = (c) => { const i = CAT_ORDER.indexOf(c); return i < 0 ? 99 : i; };
  const FILTER_ICON = '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 4h18l-7 8v6l-4 2v-8z"></path></svg>';

  // ===================================================================
  // Helpers
  // ===================================================================
  const sumOf = (rows, fields) => Object.fromEntries(fields.map((k) => [k, rows.reduce((s, r) => s + Number(r[k] || 0), 0)]));

  function groupBy(rows, keyFn, fields, init) {
    const map = new Map();
    rows.forEach((r) => {
      const k = keyFn(r);
      if (!map.has(k)) map.set(k, { ...init(r), ...Object.fromEntries(fields.map((x) => [x, 0])) });
      const g = map.get(k);
      fields.forEach((x) => { g[x] += Number(r[x] || 0); });
    });
    return [...map.values()];
  }

  // Query on a report view, filtered by the page filters.
  // The category / item / voided views have no status or payment column; those filters are skipped there.
  function q(view, cols, { status = true, payment = true } = {}) {
    let x = sb.from(view).select(cols).gte('sale_date', f.from).lte('sale_date', f.to);
    if (status && f.status) x = x.eq('status', f.status);
    if (payment && f.payment) x = x.eq('payment_method', f.payment);
    return x;
  }

  const money = (h, k) => ({ h, num: true, v: (r) => fmt(r[k]) });
  const qty = { h: 'Qty', num: true, v: (r) => Number(r.quantity).toLocaleString('en-US') };

  // ===================================================================
  // Views (tabs)
  // ===================================================================
  const DAILY_F = ['receipts', 'gross_khr', 'discount_khr', 'adjustment_khr', 'net_khr', 'cash_khr', 'bank_khr'];
  const LINE_F = ['quantity', 'gross_khr', 'discount_khr', 'net_khr'];

  const TABS = {
    daily: {
      load: async () => (await fetchAll(() => q('report_daily', 'sale_date, status, payment_method, receipts, gross_khr, discount_khr, adjustment_khr, net_khr')
        .order('sale_date').order('status').order('payment_method')))
        .map((r) => ({
          ...r,
          cash_khr: r.payment_method === 'Cash' ? r.net_khr : 0,
          bank_khr: r.payment_method === 'Bank' ? r.net_khr : 0
        })),
      view(data) {
        const month = $('groupBy').value === 'month';
        const key = (r) => (month ? r.sale_date.slice(0, 7) : r.sale_date);
        const rows = groupBy(data, key, DAILY_F, (r) => ({ key: key(r) })).sort((a, b) => b.key.localeCompare(a.key));
        return {
          cols: [
            { h: month ? 'Month' : 'Date', v: (r) => esc(r.label ?? (month ? monthLabel(r.key) : dayLabelLong(r.key))) },
            { h: 'Receipts', num: true, v: (r) => r.receipts },
            money('Gross', 'gross_khr'), money('Discount', 'discount_khr'),
            { h: 'Adjustment', num: true, v: (r) => (r.adjustment_khr ? signed(r.adjustment_khr) : '—') },
            money('Net', 'net_khr'), money('Cash', 'cash_khr'), money('Bank', 'bank_khr')
          ],
          rows,
          totals: { label: 'Total', ...sumOf(rows, DAILY_F) }
        };
      }
    },

    category: {
      note: 'Sales value before receipt adjustments, so totals can differ from Daily net by the adjustment amount.',
      filters: ['category', 'sub'],
      load: () => fetchAll(() => q('report_by_category', 'sale_date, status, category, sub_category, quantity, gross_khr, discount_khr, net_khr', { payment: false })
        .order('sale_date').order('status').order('category').order('sub_category')),
      view(data) {
        const rows = groupBy(data, (r) => `${r.category}|${r.sub_category ?? ''}`, LINE_F,
          (r) => ({ category: r.category, sub: r.sub_category ?? '' }))
          .sort((a, b) => catRank(a.category) - catRank(b.category) || a.sub.localeCompare(b.sub));
        return {
          cols: [
            { h: 'Category', f: 'category', v: (r) => esc(r.label ?? r.category) },
            { h: 'Sub-category', f: 'sub', v: (r) => esc(r.sub ?? '') },
            qty, money('Gross', 'gross_khr'), money('Discount', 'discount_khr'), money('Net', 'net_khr')
          ],
          rows,
          totals: { label: 'Total', sub: '', ...sumOf(rows, LINE_F) }
        };
      }
    },

    items: {
      note: 'Sales value before receipt adjustments. Sorted by net, highest first.',
      filters: ['item', 'category'],
      load: () => fetchAll(() => q('report_by_item', 'sale_date, status, category, description, quantity, gross_khr, discount_khr, net_khr', { payment: false })
        .order('sale_date').order('status').order('category').order('description')),
      view(data) {
        const rows = groupBy(data, (r) => `${r.category}|${r.description}`, LINE_F,
          (r) => ({ category: r.category, description: r.description }))
          .sort((a, b) => b.net_khr - a.net_khr);
        return {
          cols: [
            { h: 'Item', f: 'item', v: (r) => esc(r.label ?? r.description) },
            { h: 'Category', f: 'category', v: (r) => esc(r.category ?? '') },
            qty, money('Gross', 'gross_khr'), money('Discount', 'discount_khr'), money('Net', 'net_khr')
          ],
          rows,
          totals: { label: 'Total', category: '', ...sumOf(rows, LINE_F) }
        };
      }
    },

    voided: {
      note: 'Voided receipts are not counted in any revenue figure.',
      load: () => fetchAll(() => q('report_voided_sales', 'receipt_no, sale_date, payment_method, total_khr, void_reason, voided_at, voided_by_name, entered_by_name', { status: false })
        .order('sale_date', { ascending: false }).order('receipt_no', { ascending: false })),
      view(data) {
        return {
          cols: [
            { h: 'Receipt', v: (r) => (r.label ? esc(r.label) : `#${r.receipt_no}`) },
            { h: 'Date', v: (r) => (r.sale_date ? dayLabel(r.sale_date) : '') },
            { h: 'Payment', v: (r) => esc(r.payment_method ?? '') },
            money('Total', 'total_khr'),
            { h: 'Reason', v: (r) => esc(r.void_reason ?? '') },
            { h: 'Voided', v: (r) => (r.voided_at ? `${dateTime(r.voided_at)}<br><span class="small">${esc(r.voided_by_name ?? '')}</span>` : '') },
            { h: 'Entered by', v: (r) => esc(r.entered_by_name ?? '') }
          ],
          rows: data,
          totals: { label: `Total (${data.length})`, ...sumOf(data, ['total_khr']) }
        };
      }
    }
  };

  // ===================================================================
  // Rendering
  // ===================================================================
  function renderStats() {
    const t = sumOf(cache.daily || [], DAILY_F);
    $('statNet').textContent = fmt(t.net_khr);
    $('statNetSub').textContent = `Cash ${fmt(t.cash_khr)} · Bank ${fmt(t.bank_khr)}`;
    $('statReceipts').textContent = t.receipts.toLocaleString('en-US');
    $('statReceiptsSub').textContent = t.receipts ? `Average ${fmt(Math.round(t.net_khr / t.receipts))}` : '';
    $('statGross').textContent = fmt(t.gross_khr);
    $('statDiscount').textContent = fmt(t.discount_khr);
    $('statAdjust').textContent = t.adjustment_khr ? signed(t.adjustment_khr) : fmt(0);
  }

  // ---- Column filters ----
  const filterRows = (tab, rows) => {
    const on = (TABS[tab].filters || []).filter((k) => colSel[`${tab}.${k}`]);
    return on.length ? rows.filter((r) => on.every((k) => colSel[`${tab}.${k}`].has(FIELD[k](r)))) : rows;
  };

  function filterOptions(k, raw) {
    const vals = [...new Set(raw.map(FIELD[k]))];
    return k === 'category'
      ? vals.sort((a, b) => catRank(a) - catRank(b) || a.localeCompare(b))
      : vals.sort((a, b) => a.localeCompare(b));
  }

  function headCell(c, raw) {
    if (!c.f) return `<th class="${c.num ? 'num' : ''}">${c.h}</th>`;
    const key = `${active}.${c.f}`;
    const sel = colSel[key];
    const items = filterOptions(c.f, raw).map((v) =>
      `<label class="col-filter-item"><input class="form-check-input" type="checkbox" data-v="${esc(v)}"${!sel || sel.has(v) ? ' checked' : ''}><span>${v === '' ? '(none)' : esc(v)}</span></label>`).join('');
    return `<th><span class="col-filter-head">${c.h}<span class="dropdown col-filter" data-key="${key}">`
      + `<button type="button" class="col-filter-btn" data-bs-toggle="dropdown" aria-expanded="false" aria-label="Filter ${esc(c.h)}">${FILTER_ICON}</button>`
      + '<div class="dropdown-menu col-filter-menu">'
      + `<input type="search" class="form-control form-control-sm col-filter-search" placeholder="Search…" aria-label="Search ${esc(c.h)}">`
      + '<div class="col-filter-tools"><button type="button" class="btn btn-link btn-sm p-0" data-act="all">Select all</button><button type="button" class="btn btn-link btn-sm p-0" data-act="none">Clear all</button></div>'
      + `<div class="col-filter-list">${items}</div>`
      + '</div></span></span></th>';
  }

  const markFilters = () => document.querySelectorAll('#reportHead .col-filter').forEach((w) =>
    w.querySelector('.col-filter-btn').classList.toggle('is-filtered', !!colSel[w.dataset.key]));

  function commitFilter(wrap) {
    const boxes = [...wrap.querySelectorAll('.col-filter-item input')];
    const picked = boxes.filter((i) => i.checked).map((i) => i.dataset.v);
    colSel[wrap.dataset.key] = picked.length === boxes.length ? null : new Set(picked);
    renderTab(true);   // keep the header (and its open menu) in place
  }

  function onHeadEvent(e) {
    if (e.type === 'input') {
      const s = e.target.closest('.col-filter-search');
      if (!s) return;
      const term = s.value.trim().toLowerCase();
      s.closest('.col-filter-menu').querySelectorAll('.col-filter-item').forEach((l) => {
        l.classList.toggle('hidden', !!term && !l.textContent.toLowerCase().includes(term));
      });
    } else if (e.type === 'change') {
      if (e.target.matches('.col-filter-item input')) commitFilter(e.target.closest('.col-filter'));
    } else {
      const a = e.target.closest('[data-act]');
      if (!a) return;
      const wrap = a.closest('.col-filter');
      wrap.querySelectorAll('.col-filter-item:not(.hidden) input').forEach((i) => { i.checked = a.dataset.act === 'all'; });
      commitFilter(wrap);
    }
  }

  function renderTab(keepHead = false) {
    const tab = TABS[active];
    const data = cache[active];
    $('dailyTools').classList.toggle('hidden', active !== 'daily');

    if (!data) {
      $('tabNote').textContent = tab.note || '';
      $('tabNote').classList.toggle('hidden', !tab.note);
      $('reportHead').innerHTML = '';
      $('reportFoot').innerHTML = '';
      $('reportBody').innerHTML = '<tr><td class="empty">Loading…</td></tr>';
      return;
    }

    const { cols, rows, totals } = tab.view(filterRows(active, data));
    const filtered = (tab.filters || []).some((k) => colSel[`${active}.${k}`]);

    const note = [
      tab.note,
      f.payment && active !== 'daily' && active !== 'voided' ? 'The Payment filter does not apply to this view.' : '',
      filtered ? 'Column filters are applied: totals match the selected rows only (summary cards above are not affected).' : ''
    ].filter(Boolean).join(' ');
    $('tabNote').textContent = note;
    $('tabNote').classList.toggle('hidden', !note);

    const cell = (c, r) => `<td class="${c.num ? 'num' : ''}">${c.v(r)}</td>`;
    if (!keepHead) {
      $('reportHead').innerHTML = `<tr>${cols.map((c) => headCell(c, data)).join('')}</tr>`;
      // "fixed" positioning lets the menu float above the table's scroll area instead of being clipped
      $('reportHead').querySelectorAll('.col-filter-btn').forEach((b) => bootstrap.Dropdown.getOrCreateInstance(b, {
        autoClose: 'outside',
        popperConfig: (d) => ({ ...d, strategy: 'fixed' })
      }));
      markFilters();
    } else {
      markFilters();
    }
    $('reportBody').innerHTML = rows.length
      ? rows.map((r) => `<tr>${cols.map((c) => cell(c, r)).join('')}</tr>`).join('')
      : `<tr><td class="empty" colspan="${cols.length}">No data for these filters.</td></tr>`;
    $('reportFoot').innerHTML = rows.length ? `<tr>${cols.map((c) => cell(c, totals)).join('')}</tr>` : '';
  }

  // ===================================================================
  // Loading
  // ===================================================================
  const invalidate = () => { gen += 1; cache = {}; };

  // Daily data always feeds the summary cards; the active tab loads on demand.
  async function refresh() {
    const my = gen;
    renderTab();
    try {
      await Promise.all([...new Set(['daily', active])].map(async (t) => {
        if (cache[t]) return;
        const data = await TABS[t].load();
        if (my === gen) cache[t] = data;
      }));
    } catch (err) {
      if (my === gen) toast(`Could not load report: ${err.message}`, 'error', { sticky: true });
      return;
    }
    if (my !== gen) return;   // filters changed while loading
    renderStats();
    renderTab();
  }

  // ===================================================================
  // Filters
  // ===================================================================
  function syncFilterInputs() {
    $('fFrom').value = f.from;
    $('fTo').value = f.to;
    $('fStatus').value = f.status;
    $('fPayment').value = f.payment;
    $('rangeSummary').textContent = f.from === f.to ? dayLabel(f.from) : `${dayLabel(f.from)} – ${dayLabel(f.to)}`;
  }

  function applyFilters(next) {
    f = next;
    syncFilterInputs();
    invalidate();
    refresh();
  }

  function onFilterChange(e) {
    const next = {
      from: $('fFrom').value || todayStr(),
      to: $('fTo').value || todayStr(),
      status: $('fStatus').value,
      payment: $('fPayment').value
    };
    if (e?.target.id === 'fTo' && next.to < next.from) next.from = next.to;
    else if (next.from > next.to) next.to = next.from;
    applyFilters(next);
  }

  function onPreset(e) {
    const btn = e.target.closest('[data-preset]');
    if (!btn) return;
    const t = todayStr();
    const [y, m] = t.split('-').map(Number);
    const range = {
      today: [t, t],
      yesterday: [shiftDay(t, -1), shiftDay(t, -1)],
      month: [monthStart(t), t],
      lastMonth: [utcDay(y, m - 2, 1), utcDay(y, m - 1, 0)]
    }[btn.dataset.preset];
    applyFilters({ ...f, from: range[0], to: range[1] });
  }

  function setTab(name) {
    active = name;
    document.querySelectorAll('#reportTabs .nav-link').forEach((b) => {
      b.classList.toggle('active', b.dataset.tab === name);
      b.setAttribute('aria-selected', String(b.dataset.tab === name));
    });
    refresh();
  }

  // ===================================================================
  // Start
  // ===================================================================
  function init(detail) {
    me = detail;
    if (!me.perms.includes('view_report')) {
      $('noAccess').classList.remove('hidden');
      return;
    }
    $('reportRoot').classList.remove('hidden');

    syncFilterInputs();
    ['fFrom', 'fTo', 'fStatus', 'fPayment'].forEach((id) => $(id).addEventListener('change', onFilterChange));
    document.querySelector('.filter-actions').addEventListener('click', onPreset);
    $('reportTabs').addEventListener('click', (e) => {
      const b = e.target.closest('.nav-link');
      if (b && b.dataset.tab !== active) setTab(b.dataset.tab);
    });
    $('groupBy').addEventListener('change', () => renderTab());
    ['input', 'change', 'click'].forEach((t) => $('reportHead').addEventListener(t, onHeadEvent));

    refresh();
    // Views cannot be subscribed to, so refetch when the underlying tables change.
    RealtimeSync.watch({ name: 'reports', tables: ['sales', 'sale_items'], onChange: () => { invalidate(); refresh(); } });
  }

  window.addEventListener('app:ready', (e) => init(e.detail), { once: true });
})();
