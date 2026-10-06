// assets/js/sales.js
// Sales page: stat cards, sales table (live), filters, paging, confirm, Excel export.
// The new / edit / view form is the reusable SaleForm (assets/js/sale-form.js); it also holds the Void and Edit buttons.
// The table row only has a Confirm button, in an "Action" column shown to users with the confirm_revenue permission.
// Reads: sales (+ sale_items). Writes only through the database function confirm_sale (SaleForm.confirmSale / confirm all).
// Super Admin is not limited by status: can edit Pending / Confirmed sales and void Confirmed ones (in the form).
// Load AFTER sidebar.js (it fires `app:ready`) and sale-form.js.
(() => {
  const { $, esc, toast, badge, fetchAll, fmt, signed, todayStr, dayLabel, shiftDay } = UI;
  const hhmm = (t) => (t || '').slice(0, 5);   // 'HH:MM:SS' -> 'HH:MM'

  let me;            // app:ready detail
  let can = () => false;
  let rows = [];     // sales on the current page
  const isSuper = () => me?.role === 'Super Admin';
  const showAction = () => can('confirm_revenue');   // the "Action" column
  const colCount = () => (showAction() ? 7 : 6);

  // ===================================================================
  // Filters, paging, stat cards, table
  // ===================================================================
  const PAGE_SIZES = [10, 25, 50, 100];
  const PAGE_SIZE_KEY = 'mw.sales.pageSize';
  const TABLE_SELECT = 'id, receipt_no, status, payment_method, plate_no, customer, remark, void_reason, total_khr, discount_khr, adjustment_khr, sale_time, created_by, sale_items(line_no, description, quantity, discount_khr)';
  const EXPORT_SELECT = 'id, receipt_no, sale_date, sale_time, status, payment_method, plate_no, customer, remark, void_reason, subtotal_khr, discount_khr, adjustment_khr, adjustment_reason, total_khr, created_at, sale_items(line_no, description, quantity, gross_khr, discount_khr, total_khr)';

  const defaultFilters = (d = todayStr()) => ({ from: d, to: d, status: '', payment: '', search: '' });

  let f = defaultFilters();
  let page = 1;
  let pageSize = 25;
  let total = 0;          // records matching the filters (all pages)
  let pendingCount = 0;   // Pending records matching the filters (all pages)

  function syncFilterInputs() {
    $('fFrom').value = f.from;
    $('fTo').value = f.to;
    $('fStatus').value = f.status;
    $('fPayment').value = f.payment;
    $('fSearch').value = f.search;
  }

  function updateFilterSummary() {
    const t = todayStr();
    $('filterSummary').textContent = f.from === f.to
      ? (f.from === t ? 'Today' : dayLabel(f.from))
      : `${dayLabel(f.from)} – ${dayLabel(f.to)}`;
    const n = (f.from !== t || f.to !== t ? 1 : 0) + (f.status ? 1 : 0) + (f.payment ? 1 : 0) + (f.search ? 1 : 0);
    $('filterCount').textContent = String(n);
    $('filterCount').classList.toggle('hidden', n === 0);
  }

  function applyFilters(next) {
    f = next;
    syncFilterInputs();
    updateFilterSummary();
    page = 1;
    loadAll();
  }

  function onFilterChange(e) {
    const next = {
      from: $('fFrom').value || todayStr(),
      to: $('fTo').value || todayStr(),
      status: $('fStatus').value,
      payment: $('fPayment').value,
      search: $('fSearch').value.trim()
    };
    if (e?.target.id === 'fTo' && next.to < next.from) next.from = next.to;
    else if (next.from > next.to) next.to = next.from;
    applyFilters(next);
  }

  function onPreset(e) {
    const btn = e.target.closest('[data-preset]');
    if (!btn) return;
    const t = todayStr();
    const range = {
      today: [t, t],
      yesterday: [shiftDay(t, -1), shiftDay(t, -1)],
      month: [`${t.slice(0, 8)}01`, t]
    }[btn.dataset.preset];
    applyFilters({ ...f, from: range[0], to: range[1] });
  }

  // Filtered query on sales. `status` can be overridden (stats ignore the status filter).
  function baseQuery(select, { count, status = f.status } = {}) {
    let q = sb.from('sales').select(select, count ? { count } : undefined)
      .gte('sale_date', f.from).lte('sale_date', f.to);
    if (status) q = q.eq('status', status);
    if (f.payment) q = q.eq('payment_method', f.payment);
    const term = f.search.replace(/[,()%*\\]/g, ' ').trim();
    if (term) {
      const parts = [`plate_no.ilike.*${term}*`, `customer.ilike.*${term}*`];
      if (/^#?\d{1,15}$/.test(term)) parts.push(`receipt_no.eq.${term.replace('#', '')}`);
      q = q.or(parts.join(','));
    }
    return q;
  }

  // ---- table page ----
  let pageSeq = 0;
  let loadError = null;   // sticky 'could not load' message, closed once a load succeeds
  async function loadPage() {
    const my = ++pageSeq;
    const from = (page - 1) * pageSize;
    const { data, error, count } = await baseQuery(TABLE_SELECT, { count: 'exact' })
      .order('sale_date', { ascending: false })
      .order('sale_time', { ascending: false })
      .order('receipt_no', { ascending: false })
      .range(from, from + pageSize - 1);
    if (my !== pageSeq) return;   // a newer request is already running

    if (error) {
      if (error.code === 'PGRST103' && page > 1) { page = 1; return loadPage(); }   // page no longer exists
      loadError?.dismiss();
      loadError = toast(`Could not load sales: ${error.message}`, 'error', { sticky: true });
      return;
    }
    loadError?.dismiss(); loadError = null;
    total = count || 0;
    if (page > 1 && !data.length && total > 0) { page = Math.ceil(total / pageSize); return loadPage(); }
    rows = data || [];
    renderTable();
    renderPager();
  }

  function renderPager() {
    const pages = Math.max(1, Math.ceil(total / pageSize));
    const first = total ? (page - 1) * pageSize + 1 : 0;
    const last = Math.min(page * pageSize, total);
    $('pageInfo').textContent = total ? `${first}–${last} of ${total}` : 'No records';
    $('pageNum').textContent = `Page ${page} of ${pages}`;
    $('prevBtn').disabled = page <= 1;
    $('nextBtn').disabled = page >= pages;
  }

  // ---- stat cards (all pages of the filter, ignoring the status filter) ----
  let statSeq = 0;
  async function loadStats() {
    const my = ++statSeq;
    let data;
    try {
      data = await fetchAll(() => baseQuery('status, total_khr', { status: '' }).order('receipt_no'));
    } catch (err) {
      toast(`Could not load totals: ${err.message}`);
      return;
    }
    if (my !== statSeq) return;

    const by = { Pending: { n: 0, sum: 0 }, Confirmed: { n: 0, sum: 0 }, Voided: { n: 0, sum: 0 } };
    data.forEach((r) => { by[r.status].n += 1; by[r.status].sum += Number(r.total_khr); });
    const live = { n: by.Pending.n + by.Confirmed.n, sum: by.Pending.sum + by.Confirmed.sum };
    const count = (n) => `${n} receipt${n === 1 ? '' : 's'}`;

    $('statNet').textContent = fmt(live.sum);
    $('statNetSub').textContent = count(live.n);
    $('statConfirmed').textContent = fmt(by.Confirmed.sum);
    $('statConfirmedSub').textContent = count(by.Confirmed.n);
    $('statPending').textContent = String(by.Pending.n);
    $('statPendingSub').textContent = `${fmt(by.Pending.sum)} waiting for confirmation`;
    $('statVoided').textContent = String(by.Voided.n);

    // "Confirm all" only covers Pending records that match the status filter too.
    pendingCount = f.status && f.status !== 'Pending' ? 0 : by.Pending.n;
    $('confirmAllBtn').textContent = `Confirm all pending (${pendingCount})`;
    $('confirmAllBtn').classList.toggle('hidden', !can('confirm_revenue') || pendingCount === 0);
  }

  const loadAll = () => Promise.all([loadPage(), loadStats()]);

  // ---- table rows ----
  function rowHtml(r) {
    const items = [...(r.sale_items || [])]
      .sort((a, b) => a.line_no - b.line_no)
      .map((i) => `${esc(i.description)} ×${i.quantity}`)
      .join('<br>');
    const itemDisc = (r.sale_items || []).reduce((t, i) => t + Number(i.discount_khr || 0), 0);
    const notes = [
      itemDisc ? `Item discounts −${itemDisc.toLocaleString('en-US')} ៛` : '',
      Number(r.discount_khr) ? `Discount −${Number(r.discount_khr).toLocaleString('en-US')} ៛` : '',
      Number(r.adjustment_khr) ? `Adjustment ${signed(Number(r.adjustment_khr))}` : '',
      r.remark ? esc(r.remark) : ''
    ].filter(Boolean).join(' · ');

    const buyer = [r.plate_no, r.customer].filter(Boolean).map(esc).join('<br>') || '—';

    const action = !showAction() ? ''
      : `<td>${r.status === 'Pending' ? `<button type="button" class="btn btn-primary btn-sm" data-action="confirm" data-id="${r.id}">Confirm</button>` : ''}</td>`;

    return `<tr class="row-click${r.status === 'Voided' ? ' row-voided' : ''}" data-id="${r.id}" tabindex="0" title="View details">
      <td>#${r.receipt_no}<br><span class="small">${hhmm(r.sale_time)}</span></td>
      <td>${buyer}</td>
      <td>${items}${notes ? `<br><span class="small">${notes}</span>` : ''}</td>
      <td>${esc(r.payment_method)}</td>
      <td class="num">${fmt(r.total_khr)}</td>
      <td>${badge(r.status, r.void_reason || '')}</td>
      ${action}
    </tr>`;
  }

  function renderTable() {
    $('salesBody').innerHTML = rows.length
      ? rows.map(rowHtml).join('')
      : `<tr><td colspan="${colCount()}" class="empty">No sales.</td></tr>`;
  }

  // ---- confirm one record (Void / Edit are in the form) ----
  async function onTableClick(e) {
    const btn = e.target.closest('button[data-action]');
    if (!btn) {   // click on the row itself: open the receipt details (read-only)
      const tr = e.target.closest('tr[data-id]');
      if (tr) SaleForm.open(tr.dataset.id, { view: true });
      return;
    }
    const row = rows.find((r) => r.id === btn.dataset.id);
    if (!row) return;

    btn.disabled = true;
    const done = await SaleForm.confirmSale(row);   // asks first; null = cancelled
    if (done === null) btn.disabled = false; else await loadAll();
  }

  // ---- confirm all pending (every page of the current filter) ----
  async function confirmAll() {
    const btn = $('confirmAllBtn');
    btn.disabled = true;

    let pending;
    try {
      pending = await fetchAll(() => baseQuery('id, receipt_no, total_khr', { status: 'Pending' }).order('receipt_no'));
    } catch (err) {
      btn.disabled = false;
      return toast(err.message);
    }
    if (!pending.length) { btn.disabled = false; return loadAll(); }

    const sum = pending.reduce((t, r) => t + Number(r.total_khr), 0);
    const range = f.from === f.to ? dayLabel(f.from) : `${dayLabel(f.from)} – ${dayLabel(f.to)}`;
    if (!confirm(`Confirm ${pending.length} pending receipt${pending.length === 1 ? '' : 's'} (${fmt(sum)}) for ${range}?${isSuper() ? '' : '\n\nConfirmed sales can no longer be voided.'}`)) {
      btn.disabled = false;
      return;
    }

    // A few at a time; the database confirms one sale per call.
    const failed = [];
    let done = 0;
    const queue = [...pending];
    const worker = async () => {
      while (queue.length) {
        const sale = queue.shift();
        const { error } = await sb.rpc('confirm_sale', { p_sale_id: sale.id });
        if (error) failed.push(`#${sale.receipt_no}: ${error.message}`);
        done += 1;
        $('confirmProgress').textContent = `Confirming ${done} / ${pending.length}…`;
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, queue.length) }, worker));

    $('confirmProgress').textContent = '';
    btn.disabled = false;
    if (failed.length) {
      toast(`Confirmed ${pending.length - failed.length} of ${pending.length}. Failed: ${failed.slice(0, 3).join(' | ')}${failed.length > 3 ? ' …' : ''}`, 'error', { sticky: true });
    } else {
      toast(`Confirmed ${pending.length} receipt${pending.length === 1 ? '' : 's'}.`, 'ok');
    }
    await loadAll();
  }

  // ---- export to Excel (all records of the current filter) ----
  let xlsxPromise = null;
  function loadXlsx() {   // loaded on first use only, so the page itself stays light
    if (window.XLSX) return Promise.resolve();
    xlsxPromise ??= new Promise((resolve, reject) => {
      const el = document.createElement('script');
      el.src = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';
      el.onload = resolve;
      el.onerror = () => { xlsxPromise = null; reject(new Error('Could not load the Excel library. Check your internet connection.')); };
      document.head.appendChild(el);
    });
    return xlsxPromise;
  }

  function addSheet(wb, name, data) {
    const ws = XLSX.utils.json_to_sheet(data);
    const headers = Object.keys(data[0]);
    ws['!cols'] = headers.map((h) => ({
      wch: Math.min(40, Math.max(h.length, ...data.map((r) => String(r[h] ?? '').length)) + 2)
    }));
    Object.keys(ws).forEach((addr) => {
      if (addr[0] === '!') return;
      const cell = ws[addr];
      if (cell.t === 'n' && /KHR/.test(headers[XLSX.utils.decode_cell(addr).c])) cell.z = '#,##0';
    });
    XLSX.utils.book_append_sheet(wb, ws, name);
  }

  async function exportExcel() {
    const btn = $('exportBtn');
    const label = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Exporting…';
    try {
      const [data] = await Promise.all([
        fetchAll(() => baseQuery(EXPORT_SELECT).order('sale_date').order('sale_time').order('receipt_no')),
        loadXlsx()
      ]);
      if (!data.length) return toast('Nothing to export for these filters.');

      const lines = (r) => [...(r.sale_items || [])].sort((a, b) => a.line_no - b.line_no);
      const sales = data.map((r) => ({
        'Receipt No': r.receipt_no,
        'Date': r.sale_date,
        'Time': hhmm(r.sale_time),
        'Status': r.status,
        'Payment': r.payment_method,
        'Plate': r.plate_no ?? '',
        'Customer': r.customer ?? '',
        'Items': lines(r).map((i) => `${i.description} ×${i.quantity}`).join('; '),
        'Subtotal (KHR)': Number(r.subtotal_khr),
        'Receipt discount (KHR)': Number(r.discount_khr),
        'Adjustment (KHR)': Number(r.adjustment_khr),
        'Adjustment reason': r.adjustment_reason ?? '',
        'Total (KHR)': Number(r.total_khr),
        'Remark': r.remark ?? '',
        'Void reason': r.void_reason ?? ''
      }));
      const items = data.flatMap((r) => lines(r).map((i) => ({
        'Receipt No': r.receipt_no,
        'Date': r.sale_date,
        'Time': hhmm(r.sale_time),
        'Status': r.status,
        'Line': i.line_no,
        'Description': i.description,
        'Quantity': i.quantity,
        'Gross (KHR)': Number(i.gross_khr),
        'Item discount (KHR)': Number(i.discount_khr),
        'Line total (KHR)': Number(i.total_khr)
      })));

      const wb = XLSX.utils.book_new();
      addSheet(wb, 'Sales', sales);
      if (items.length) addSheet(wb, 'Items', items);
      XLSX.writeFile(wb, `sales_${f.from}${f.to !== f.from ? `_to_${f.to}` : ''}.xlsx`);
    } catch (err) {
      toast(`Export failed: ${err.message}`);
    } finally {
      btn.disabled = false;
      btn.textContent = label;
    }
  }

  // ===================================================================
  // Start
  // ===================================================================
  async function init(detail) {
    me = detail;
    can = (key) => me.perms.includes(key);

    try {
      const saved = Number(localStorage.getItem(PAGE_SIZE_KEY));
      if (PAGE_SIZES.includes(saved)) pageSize = saved;
    } catch (_) { /* ignore */ }
    $('pageSize').value = String(pageSize);
    syncFilterInputs();
    updateFilterSummary();
    $('actionTh').classList.toggle('hidden', !showAction());

    // filters
    $('filterBtn').addEventListener('click', () => {
      const open = $('filterBar').classList.toggle('hidden') === false;
      $('filterBtn').setAttribute('aria-expanded', String(open));
    });
    ['fFrom', 'fTo', 'fStatus', 'fPayment'].forEach((id) => $(id).addEventListener('change', onFilterChange));
    let searchTimer;
    $('fSearch').addEventListener('input', (e) => { clearTimeout(searchTimer); searchTimer = setTimeout(() => onFilterChange(e), 300); });
    $('filterBar').addEventListener('click', onPreset);
    $('resetFilters').addEventListener('click', () => applyFilters(defaultFilters()));

    // paging
    $('pageSize').addEventListener('change', () => {
      pageSize = Number($('pageSize').value);
      try { localStorage.setItem(PAGE_SIZE_KEY, String(pageSize)); } catch (_) { /* ignore */ }
      page = 1;
      loadPage();
    });
    $('prevBtn').addEventListener('click', () => { if (page > 1) { page -= 1; loadPage(); } });
    $('nextBtn').addEventListener('click', () => { page += 1; loadPage(); });

    // table actions
    $('salesBody').addEventListener('click', onTableClick);
    $('salesBody').addEventListener('keydown', (e) => {   // Enter on a focused row = click
      if (e.key === 'Enter' && e.target.matches('tr[data-id]')) SaleForm.open(e.target.dataset.id, { view: true });
    });
    $('confirmAllBtn').addEventListener('click', confirmAll);
    $('exportBtn').addEventListener('click', exportExcel);

    loadAll();
    RealtimeSync.watch({ name: 'sales', tables: ['sales', 'sale_items'], onChange: loadAll });

    // new / edit / view form (shared component)
    SaleForm.init(detail, { onSaved: ({ date }) => applyFilters(defaultFilters(date)), onChanged: loadAll });   // show the saved sale (its date, no other filters)
    if (can('enter_revenue')) $('newSaleBtn').addEventListener('click', () => SaleForm.openNew());
    else $('newSaleBtn').classList.add('hidden');
  }

  window.addEventListener('app:ready', (e) => init(e.detail), { once: true });
})();
